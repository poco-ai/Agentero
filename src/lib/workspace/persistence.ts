/**
 * Save open editors and reload them when the file changes on disk.
 */

import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import {
	notifyError,
	notifyReminder,
	notifyUndo,
	notifyWarning,
} from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { localFileToArrayBuffer } from "@/lib/paper";
import { isRecentBookmarkWrite } from "@/lib/pdf/bookmark-echo";
import { isResearchTablePath } from "@/lib/research-table/model";
import { onTexFileSaved } from "@/lib/tex/auto-build";
import {
	isMarkdownPath,
	readVaultFile,
	vaultRelativePath,
	writeVaultFile,
} from "@/lib/vault";
import { primeSeedCache } from "@/lib/vault/seed-cache";
import { getVaultPath } from "@/lib/vault/store";
import { applyWikiPaths } from "@/lib/wiki/api";
import {
	bumpWikiIndexRevision,
	isSelfWrittenContent,
	trackSelfWrittenPath,
} from "@/lib/wiki/store";
import { getTabs, setTabs } from "@/lib/workspace/store";
import {
	type DocTab,
	normalizeTabPath,
	refreshPdfTab,
	seedTabs,
	syncTabSeedsForPath,
	tabIsPaperNotes,
} from "./tabs";
import { isHtmlPath, viewerModeSpec } from "./viewer";

/** Collect vault-relative paths with unsaved edits (rename preflight). */
export function dirtyVaultPaths(root: string): string[] {
	const dirty = new Set<string>();
	for (const tab of getTabs()) {
		if (tab.markdownDirty) {
			const rel = vaultRelativePath(root, tab.path);
			if (rel) dirty.add(rel);
		}
		if (tab.notesDirty && tab.notesPath) {
			const rel = vaultRelativePath(root, tab.notesPath);
			if (rel) dirty.add(rel);
		}
	}
	return [...dirty];
}

/** Normalized paths currently being reloaded from disk; suppresses any racing
 * editor autosave so an external/Agent write is never clobbered by stale
 * in-memory text. */
const reseedGuard = new Set<string>();

/** The editors that autosave through the shared persist pipeline. */
type PersistKind = "markdown" | "excalidraw" | "text";

/** Serialized saves per kind, keyed by normalized absolute path: overlapping
 * editor lifecycles cannot race their disk snapshot checks and writes. */
const persistQueues: Record<PersistKind, Map<string, Promise<boolean>>> = {
	markdown: new Map(),
	excalidraw: new Map(),
	text: new Map(),
};

/** Post-write outcome per kind, run only after the write is confirmed. */
const persistOutcomes: Record<
	PersistKind,
	(path: string, content: string, writerId: string) => void
> = {
	markdown: (path, content, writerId) => {
		primeSeedCache(path, content);
		const conflicts: string[] = [];
		setTabs((prev) => {
			const next = syncTabSeedsForPath(prev, path, content, writerId);
			for (let i = 0; i < next.length; i++) {
				if (next[i].markdownConflict && !prev[i].markdownConflict) {
					conflicts.push(next[i].id);
				}
			}
			return next;
		});
		for (const id of conflicts) promptMarkdownConflict(path, id);
	},
	excalidraw: (path, content) => {
		setTabs((prev) => seedTabs(prev, path, content, "excalidraw"));
	},
	text: (path, content) => {
		setTabs((prev) => seedTabs(prev, path, content, "text"));
		onTexFileSaved(path);
	},
};

/**
 * Where disk-change reseeds land. The main window uses the workspace tab
 * store; doc popout windows pass a single-tab sink over local React state.
 * Both run the same pure tab-list transforms (`seedTabs` / `refreshPdfTab`).
 */
export type DiskChangeSink = {
	getTabs: () => DocTab[];
	/** Apply a tab-list transform to this window's panel list. */
	updateTabs: (update: (prev: DocTab[]) => DocTab[]) => void;
};

const defaultDiskChangeSink: DiskChangeSink = {
	getTabs,
	updateTabs: (update) => setTabs(update),
};

/** Reload only the panel the user chose, reading the current disk version. */
function promptMarkdownConflict(path: string, tabId: string): void {
	const name = path.split(/[\\/]/).pop() ?? path;
	notifyReminder(i18n.t("app:diskConflict.title", { name }), {
		id: `markdown-save-conflict:${tabId}`,
		actionLabel: i18n.t("app:diskConflict.reload"),
		onAction: () => {
			void (async () => {
				try {
					const content = await readVaultFile(path);
					primeSeedCache(path, content);
					setTabs((prev) =>
						prev.map((tab) => {
							if (tab.id !== tabId) return tab;
							const notes = tabIsPaperNotes(tab);
							return seedTabs(
								[tab],
								notes ? path.replace(/[\\/]NOTES\.md$/i, "") : path,
								content,
								notes ? "notes" : "markdown",
								true,
							)[0];
						}),
					);
				} catch (error) {
					notifyError(errorText(error));
				}
			})();
		},
		dismissLabel: i18n.t("app:diskConflict.keepDraft"),
		onDismiss: () => {},
	});
}

/** One text-like editor kind for disk-change reseeding: which open tabs own
 * the path plus the tab fields holding its in-memory seed / dirty flag. */
type DiskChangeKind = {
	/** Open tabs whose editor renders this path (notes: via the paper pairing). */
	owns: (tab: DocTab, norm: string) => boolean;
	/** Tab fields holding this editor's in-memory seed / unsaved-edits flag. */
	seed: "notesSeed" | "markdownSeed" | "excalidrawSeed" | "textSeed";
	dirty: "notesDirty" | "markdownDirty" | "excalidrawDirty" | "textDirty";
	/** External-write reseed transform (pure: the sink applies it to its tabs). */
	refresh: (prev: DocTab[], absPath: string, content: string) => DocTab[];
};

const diskChangeKinds: DiskChangeKind[] = [
	{
		// Paper body tabs share notesPath so a closed NOTES pane still refreshes
		// its seed. They do not render the note; a clean body tab must not reload
		// while the NOTES editor is dirty (see the single decision below).
		owns: (tab, norm) =>
			Boolean(tab.notesPath && normalizeTabPath(tab.notesPath) === norm),
		seed: "notesSeed",
		dirty: "notesDirty",
		refresh: (prev, absPath, content) =>
			seedTabs(
				prev,
				absPath.replace(/[\\/]NOTES\.md$/i, ""),
				content,
				"notes",
				true,
			),
	},
	{
		owns: (tab, norm) =>
			normalizeTabPath(tab.path) === norm &&
			isMarkdownPath(tab.path) &&
			!tabIsPaperNotes(tab),
		seed: "markdownSeed",
		dirty: "markdownDirty",
		refresh: (prev, absPath, content) =>
			seedTabs(prev, absPath, content, "markdown", true),
	},
	{
		owns: (tab, norm) =>
			normalizeTabPath(tab.path) === norm && tab.mode === "excalidraw",
		seed: "excalidrawSeed",
		dirty: "excalidrawDirty",
		refresh: (prev, absPath, content) =>
			seedTabs(prev, absPath, content, "excalidraw", true),
	},
	{
		owns: (tab, norm) =>
			normalizeTabPath(tab.path) === norm &&
			(tab.mode === "text" || tab.mode === "research-table"),
		seed: "textSeed",
		dirty: "textDirty",
		refresh: (prev, absPath, content) =>
			seedTabs(prev, absPath, content, "text", true),
	},
];

/**
 * Reload an open editor when its file changed on disk (external editor /
 * Agent). Reseeds only when disk content differs from the current seed —
 * equal content, or the body this app just wrote, is our own autosave. A
 * dirty editor is left in place (one toast); a clean sibling must not reload
 * it. The mounted editor reloads the new seed in place (no remount); the path
 * is guarded briefly so a racing autosave cannot overwrite the fresh disk text.
 */
export async function applyDiskChange(
	absPath: string,
	sink: DiskChangeSink = defaultDiskChangeSink,
): Promise<void> {
	const norm = normalizeTabPath(absPath);
	const openTabs = sink.getTabs();
	if (
		openTabs.some(
			(tab) =>
				tab.mode === "html" &&
				isHtmlPath(tab.path) &&
				normalizeTabPath(tab.path) === norm,
		)
	) {
		sink.updateTabs((prev) =>
			prev.map((tab) =>
				tab.mode === "html" &&
				isHtmlPath(tab.path) &&
				normalizeTabPath(tab.path) === norm
					? { ...tab, htmlKey: tab.htmlKey + 1 }
					: tab,
			),
		);
	}
	const kindOwners = diskChangeKinds.map((kind) => ({
		kind,
		owners: openTabs.filter((tab) => kind.owns(tab, norm)),
	}));
	const pdfOwners = openTabs.filter(
		(t) =>
			normalizeTabPath(t.path) === norm &&
			viewerModeSpec(t.mode).resource === "pdf",
	);
	const hasTextOwners = kindOwners.some((entry) => entry.owners.length > 0);
	if (!hasTextOwners && !pdfOwners.length) return;
	// PDF panes reload from bytes: one read feeds every matching pane (source
	// tab + translation split); the fresh ArrayBuffer identity is the mounted
	// viewer's reload signal. Panes still on the compile shimmer are skipped
	// inside refreshPdfTab — the compile flow fills them when the run lands.
	// A bookmark write already updated the in-memory outline. Reloading the
	// buffer here remounts EmbedPDF and flashes the page.
	if (pdfOwners.length && !isRecentBookmarkWrite(absPath)) {
		const bytes = await localFileToArrayBuffer(absPath);
		if (bytes) sink.updateTabs((prev) => refreshPdfTab(prev, absPath, bytes));
	}
	if (!hasTextOwners) return;
	let content: string;
	try {
		content = await readVaultFile(absPath);
	} catch {
		return;
	}
	// Keep the open-path seed cache in step with what the reload just read.
	primeSeedCache(absPath, content);
	// Autosave records the body before the watcher echo. The tab seed can still
	// be the previous text: wiki indexing runs after the write, and a popout
	// copies the seed only after that returns. Reloading here wipes keystrokes
	// typed during that gap and toasts a false external edit.
	if (
		isSelfWrittenContent(absPath, content) ||
		lastOwnWriteByPath.get(norm)?.content === content
	) {
		return;
	}
	// Disk diverged from the body this window last wrote. Forget that baseline
	// so a later save cannot treat the external bytes as our own.
	lastOwnWriteByPath.delete(norm);
	// The pre-read snapshot misses a seed advanced while this read was in flight.
	const ownersNow = diskChangeKinds.map((kind) => ({
		kind,
		owners: sink.getTabs().filter((tab) => kind.owns(tab, norm)),
	}));
	const guard = () => {
		reseedGuard.add(norm);
		window.setTimeout(() => reseedGuard.delete(norm), 500);
	};
	const promptReload = (reload: () => void) => {
		const name = absPath.split(/[\\/]/).pop() ?? absPath;
		notifyUndo(i18n.t("app:diskConflict.title", { name }), {
			actionLabel: i18n.t("app:diskConflict.reload"),
			onAction: reload,
			duration: 12000,
		});
	};
	for (const { kind, owners } of ownersNow) {
		if (owners.length === 0) continue;
		const reload = () => {
			guard();
			sink.updateTabs((prev) => kind.refresh(prev, absPath, content));
		};
		const dirty = owners.filter((tab) => tab[kind.dirty]);
		if (dirty.length > 0) {
			// The paper PDF tab is a notes owner and is never marked dirty.
			// Reloading from it reseeds the NOTES editor and drops the unsaved
			// text. Toast only when a dirty editor's own seed differs.
			if (dirty.some((tab) => content !== tab[kind.seed])) promptReload(reload);
			continue;
		}
		if (owners.some((tab) => content !== tab[kind.seed])) reload();
	}
}

/**
 * Body this window last wrote, keyed by normalized path. Unlike the watcher
 * echo TTL, this stays until an external edit replaces it: PDF-anchor
 * resolution keeps the wiki lock (and the editor's saved snapshot) busy long
 * after the write, and opening `[[` searches that same index.
 */
const lastOwnWriteByPath = new Map<
	string,
	{ content: string; writerId: string }
>();

/**
 * True when `disk` is neither the editor's last saved snapshot nor a body
 * this window just wrote. Equal bytes are not an external edit.
 */
export function markdownDiskConflicts(
	disk: string,
	lastSaved: string,
	ownWrite: string | undefined,
): boolean {
	if (disk === lastSaved) return false;
	if (ownWrite !== undefined && disk === ownWrite) return false;
	return true;
}

/**
 * Shared autosave pipeline for the text-like editors (Markdown / Excalidraw /
 * plain text): per-path serialization, disk-conflict guard, self-write echo
 * registration, then the kind's post-write reseed.
 *
 * The returned promise resolves when the write and seed update finish. Wiki
 * indexing stays on the per-path queue so later saves still wait for it, but
 * the editor can adopt the new snapshot before PDF fragment resolution returns.
 */
function persistTextLike(
	kind: PersistKind,
	path: string,
	content: string,
	lastSaved: string,
	writerId = "",
): Promise<boolean> {
	if (!isTauri() || !getVaultPath() || !path) return Promise.resolve(false);
	const queues = persistQueues[kind];
	const normalizedPath = normalizeTabPath(path);
	const previous = queues.get(normalizedPath) ?? Promise.resolve(false);
	let resolveEditor: (ok: boolean) => void = () => {};
	const editorResult = new Promise<boolean>((resolve) => {
		resolveEditor = resolve;
	});
	const attempt = previous
		.catch(() => false)
		.then(async () => {
			let editorOk = false;
			try {
				// Skip while this path is being reloaded from disk (external/Agent
				// write): the unmount-flush must not clobber the fresh disk content.
				if (reseedGuard.has(normalizedPath)) return false;
				const writer =
					kind === "markdown"
						? getTabs().find((tab) => tab.id === writerId)
						: undefined;
				if (writer?.markdownConflict) {
					promptMarkdownConflict(path, writerId);
					return false;
				}
				// Conflict guard: if the file changed on disk since we last saved,
				// do NOT silently overwrite — keep the user's in-memory edit and warn.
				// A body this window wrote is not that external edit, even when the
				// editor snapshot is still the pre-index text.
				try {
					const disk = await readVaultFile(path);
					const ownWrite = lastOwnWriteByPath.get(normalizedPath);
					if (
						isResearchTablePath(path)
							? disk !== lastSaved && disk !== content
							: markdownDiskConflicts(
									disk,
									lastSaved,
									kind !== "markdown" || ownWrite?.writerId === writerId
										? ownWrite?.content
										: undefined,
								)
					) {
						if (writer) {
							setTabs((prev) =>
								prev.map((tab) =>
									tab.id === writerId
										? { ...tab, markdownConflict: true }
										: tab,
								),
							);
							promptMarkdownConflict(path, writerId);
							return false;
						}
						const name = path.split(/[\\/]/).pop() ?? path;
						const notify = isResearchTablePath(path)
							? notifyError
							: notifyWarning;
						notify(
							i18n.t("app:diskConflict.saveBlocked", { name }),
							kind === "markdown"
								? { id: `markdown-save-conflict:${normalizedPath}` }
								: undefined,
						);
						return false;
					}
				} catch (error) {
					if (isResearchTablePath(path)) throw error;
					// Missing/unreadable file → no conflict to guard against.
				}
				await writeVaultFile(path, content);
				lastOwnWriteByPath.set(normalizedPath, { content, writerId });
				// Advance the seed and remember the body before any await. Wiki
				// indexing yields long enough for the watcher echo to land; if the
				// seed is still the previous text, that echo looks like an external
				// edit and a clean paper tab reloads the note over the keystrokes.
				trackSelfWrittenPath(path, content);
				persistOutcomes[kind](path, content, writerId);
				editorOk = true;
				// The watcher echo of this write must not re-trigger a full Wiki
				// rebuild on every autosave (#270). The saved file itself is
				// folded into the index here so a later rename sees the new links.
				if (isMarkdownPath(path)) {
					const vault = getVaultPath();
					if (vault) {
						try {
							await applyWikiPaths(vault, [path]);
							bumpWikiIndexRevision();
						} catch {
							// The watcher recorded the path; rename re-reads it.
						}
					}
				}
				return true;
			} catch (e) {
				notifyError(errorText(e));
				return false;
			} finally {
				resolveEditor(editorOk);
			}
		});
	queues.set(normalizedPath, attempt);
	// Drop the queue entry once this attempt settles and is still the tail.
	const settle = () => {
		if (queues.get(normalizedPath) === attempt) queues.delete(normalizedPath);
	};
	void attempt.then(settle, settle);
	return editorResult;
}

/**
 * Persist a specific file's Markdown to disk. The MarkdownEditor calls this
 * with its own fixed path (debounced autosave, ⌘S, and unmount flush), so
 * writes always target the correct file even when switching files quickly.
 */
export function persistFile(
	path: string,
	md: string,
	lastSaved: string,
	tabId: string,
): Promise<boolean> {
	return persistTextLike("markdown", path, md, lastSaved, tabId);
}

/**
 * Persist a specific `.excalidraw` file to disk. The ExcalidrawViewer calls
 * this with its own fixed path (debounced autosave and unmount flush).
 */
export function persistExcalidrawFile(
	path: string,
	json: string,
	lastSaved: string,
): Promise<boolean> {
	return persistTextLike("excalidraw", path, json, lastSaved);
}

/**
 * Persist a plain-text editor file to disk. The CodeMirror TextEditor calls
 * this with its own fixed path (debounced autosave and unmount flush).
 */
export function persistTextFile(
	path: string,
	content: string,
	lastSaved: string,
): Promise<boolean> {
	return persistTextLike("text", path, content, lastSaved);
}
