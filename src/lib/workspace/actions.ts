/**
 * Workspace actions: open/close/cycle document panels, paper+NOTES pairing,
 * Markdown persistence, disk-change reseeding, and wiki navigation. Plain
 * functions over the vanilla stores (`getState()` replaces the old App ref
 * mirrors); dockview is driven through the registered dock handle.
 */

import i18n from "@/i18n";
import { notePaperFocus, track } from "@/lib/activity";
import { errorText } from "@/lib/core/error";
import { notifyError, notifyUndo, notifyWarning } from "@/lib/core/notify";
import { closeTopOverlay } from "@/lib/core/overlay-stack";
import { isTauri } from "@/lib/core/tauri";
import { lifecycle } from "@/lib/lifecycle";
import {
	detectPaperDirectory,
	isPaperDirectory,
	isRemoteArxivPath,
	isUnderPaperAttachments,
	paperDirFromPath,
	type RemotePaperItem,
	remoteArxivPath,
	stageRemoteArxivPaper,
} from "@/lib/paper";
import {
	isLibraryVirtualPath,
	isTrashVirtualPath,
	LIBRARY_VIRTUAL_PATH,
	resolveLibraryScopePath,
	TRASH_VIRTUAL_PATH,
} from "@/lib/paper/api";
import { refreshLibrary, setLibraryScopePath } from "@/lib/paper/library-store";
import {
	lookupAnnotationRef,
	paperAbsFromWikiTarget,
} from "@/lib/pdf/annotation-ref";
import { removeTabAnnotations } from "@/lib/pdf/annotations-store";
import {
	buildLayoutDocumentResult,
	getLayoutDocumentResult,
	mergeCaptionsIntoHosts,
	setLayoutDocumentResult,
} from "@/lib/pdf/layout";
import { readLayoutSidecar } from "@/lib/pdf/layout/io";
import { registerScrollSyncPair } from "@/lib/pdf/scroll-sync";
import {
	isPlazaVirtualPath,
	type PlazaSource,
	plazaSourceForPath,
} from "@/lib/plaza";
import { loadSettings } from "@/lib/settings";
import { setLayoutMode } from "@/lib/shell/ui-store";
import {
	type FileNode,
	isMarkdownPath,
	joinVaultPath,
	readVaultFile,
	vaultRelativePath,
	writeVaultFile,
} from "@/lib/vault";
import {
	getVaultPath,
	refreshTree,
	setTreeSelectedPath,
	vaultStore,
} from "@/lib/vault/store";
import {
	missingNotePath,
	newNoteMarkdown,
	normalizeVaultRel,
	toVaultRelative,
	type WikiNavTarget,
	wikiNavigationDestination,
} from "@/lib/wiki";
import { rebuildWikiAndNotify, trackSelfWrittenPath } from "@/lib/wiki/store";
import { dockHandle } from "@/lib/workspace/dock-registry";
import {
	getActiveTabId,
	getTabs,
	pushClosedTabs,
	refreshTabMarkdown,
	refreshTabNotes,
	setActiveTabId,
	setTabs,
	takeClosedTab,
	updateTab,
} from "@/lib/workspace/store";
import {
	type PdfViewerHandle,
	pdfHandleFor,
	subscribePdfHandles,
} from "@/lib/workspace/viewer/pdf-viewer-registry";
import {
	basenameOf,
	createNotesSplitPane,
	createPlaceholderTab,
	createTranslationSplitPane,
	type DocTab,
	ensureFullLibraryTab,
	insertPlaceholderTab,
	isPaperContentTab,
	loadTabResources,
	normalizeTabPath,
	type OpenPlacement,
	paperReadingPlacements,
	patchTab,
	readingPairCloseIds,
	removeTab,
	removeTabsUnderPath,
	revokeTabMediaSources,
	splitPaneIdForPath,
	syncTabSeedsForPath,
	tabHasNotesSplit,
	tabIdForPath,
	tabIsPaperNotes,
	tabNotesEligible,
	translationSplitPlacement,
} from "./tabs";
import { type CenterViewMode, preferredModeForPath } from "./viewer";

/**
 * When the strip would be empty with a Vault open, insert full Library.
 * Active focus is left to dockview (`onDidActivePanelChange` / sync end).
 */
function withLibraryIfEmpty(next: DocTab[]): DocTab[] {
	if (next.length > 0 || !getVaultPath()) return next;
	return ensureFullLibraryTab([]).tabs;
}

/**
 * Suppress companion-tab sync while we programmatically flip paper+NOTES
 * (avoids onActivePanelChange recursion).
 */
let readingSync = false;

/**
 * Bring a paper body panel to front; if its NOTES panel is already open,
 * activate that tab in the notes column too (focus ends on the paper).
 */
export function activatePaperWithNotes(paperTab: DocTab): void {
	const notesId = paperTab.notesPath ? tabIdForPath(paperTab.notesPath) : null;
	const notesOpen = notesId != null && getTabs().some((t) => t.id === notesId);
	readingSync = true;
	try {
		// Activate NOTES first so its group shows the matching tab; then paper
		// so focus/active id land on the body panel.
		if (notesOpen && notesId) {
			dockHandle()?.activatePanel(notesId);
		}
		dockHandle()?.activatePanel(paperTab.id);
	} finally {
		queueMicrotask(() => {
			readingSync = false;
		});
	}
	setActiveTabId(paperTab.id);
}

/**
 * Dockview focus changed: keep paper body and NOTES columns in sync when
 * the user clicks a tab in either column.
 */
export function handleActivePanelChange(panelId: string | null): void {
	setActiveTabId(panelId);
	const activeTab = panelId
		? (getTabs().find((t) => t.id === panelId) ?? null)
		: null;
	// Feature popout windows follow the main dock's active document.
	void import("@/lib/shell/workspace-broadcast").then(
		({ broadcastWorkspaceActive }) => {
			broadcastWorkspaceActive({
				path: activeTab?.path ?? null,
				vaultPath: getVaultPath(),
				paperTitle: activeTab?.paperMeta?.title ?? null,
			});
		},
	);
	if (!panelId || readingSync) {
		return;
	}
	const tab = activeTab;
	if (!tab) return;
	if (
		!isLibraryVirtualPath(tab.path) &&
		!isTrashVirtualPath(tab.path) &&
		!isRemoteArxivPath(tab.path)
	) {
		notePaperFocus(tab.path);
	}

	if (isPaperContentTab(tab) && tab.notesPath) {
		const notesId = tabIdForPath(tab.notesPath);
		if (!getTabs().some((t) => t.id === notesId)) return;
		readingSync = true;
		try {
			dockHandle()?.activatePanel(notesId);
			dockHandle()?.activatePanel(panelId);
		} finally {
			queueMicrotask(() => {
				readingSync = false;
			});
		}
		return;
	}

	if (tabIsPaperNotes(tab)) {
		const companion = getTabs().find(
			(t) =>
				isPaperContentTab(t) &&
				t.notesPath &&
				tabIdForPath(t.notesPath) === tab.id,
		);
		if (!companion) return;
		readingSync = true;
		try {
			dockHandle()?.activatePanel(companion.id);
			dockHandle()?.activatePanel(panelId);
		} finally {
			queueMicrotask(() => {
				readingSync = false;
			});
		}
	}
}

/**
 * Open a document panel. If already open → activate it (and companion NOTES).
 * Otherwise insert a placeholder, place in dockview (stack into the paper
 * column when one exists), load resources, and open NOTES into the notes
 * column (or create a right split for the first paper).
 */
export function openTab(
	path: string,
	opts?: {
		preferMode?: CenterViewMode;
		/** Place relative to an existing panel (file-tree drop / NOTES). */
		placement?: OpenPlacement;
		/** Skip default paper→NOTES companion open. */
		skipDefaultNotes?: boolean;
		/** Open the NOTES companion even when autoOpenPaperNotes is off. */
		forceNotes?: boolean;
	},
): void {
	const id = tabIdForPath(path);
	const existing = getTabs().find((t) => t.id === id);
	if (existing) {
		// Sync paper + NOTES tabs when re-opening an already-mounted paper.
		if (
			existing.kind === "paper" &&
			(existing.mode === "pdf" || existing.mode === "html")
		) {
			activatePaperWithNotes(existing);
		} else {
			setActiveTabId(id);
			dockHandle()?.activatePanel(id);
		}
		return;
	}

	const beforeTabs = getTabs();
	const { tabs: nextTabs, id: insertedId } = insertPlaceholderTab(
		beforeTabs,
		path,
		opts?.preferMode,
	);
	const placeholder =
		nextTabs.find((t) => t.id === insertedId) ??
		createPlaceholderTab(path, opts?.preferMode);

	// Paper bodies use free dock placement; NOTES companion still prefers the
	// notes column when present (see paperReadingPlacements).
	const initialPlacement =
		opts?.placement ??
		paperReadingPlacements(beforeTabs, {
			paperId: insertedId,
			activeId: getActiveTabId(),
		}).paper;

	setTabs(nextTabs);
	setActiveTabId(insertedId);
	dockHandle()?.openPanel(placeholder, initialPlacement);

	void (async () => {
		const vaultState = vaultStore.getState();
		const res = await loadTabResources(
			path,
			vaultState.vaultPath,
			vaultState.tree,
			vaultState.paperFolders,
		);
		if (res.error) {
			notifyError(
				res.error === "cannotPreview"
					? i18n.t("app:errors.cannotPreview", { name: basenameOf(path) })
					: res.error,
			);
		}
		const patch: Partial<DocTab> = {
			kind: res.kind,
			title: res.title,
			mode: res.mode,
			paperMeta: res.paperMeta,
			pdfUrl: res.pdfUrl,
			pdfBytes: res.pdfBytes ?? null,
			htmlUrl: res.htmlUrl,
			imageUrl: res.imageUrl,
			notesPath: res.notesPath,
			notesSeed: res.notesSeed,
			markdownSeed: res.markdownSeed,
			seedKey: 1,
			loaded: true,
		};
		updateTab(id, patch);

		// Paper default: NOTES in the notes column (or first-time right split).
		const wantDefaultNotes =
			!opts?.skipDefaultNotes &&
			!opts?.placement &&
			res.kind === "paper" &&
			Boolean(res.notesPath) &&
			(res.mode === "pdf" || res.mode === "html") &&
			(opts?.forceNotes || loadSettings().autoOpenPaperNotes);
		if (wantDefaultNotes && res.notesPath) {
			openNotesForPaper(id, patch, path);
		}

		const vault = getVaultPath();
		if (res.didDownloadAssets && vault) {
			await refreshTree(vault, { quiet: true });
		}
		if (!isLibraryVirtualPath(path) && !isTrashVirtualPath(path)) {
			if (res.kind === "paper" && (res.mode === "pdf" || res.mode === "html")) {
				track("paper.open", { path, mode: res.mode });
			} else if (res.kind === "paper" || res.kind === "file") {
				track("note.open", { path, mode: res.mode });
			}
			if (res.kind === "paper") {
				void lifecycle.emit("paper:opened", {
					paperId: basenameOf(path),
					timestamp: Date.now(),
				});
			}
			notePaperFocus(path);
		}
	})();
}

/**
 * Ensure the NOTES companion panel of paper tab `paperId` is open beside it.
 * `paperPatch`/`paperPath` come from a freshly loaded tab; without them the
 * patch is read from the current tab state (hydrate path).
 * The notes tab existing in state is not enough: after layout restore it may
 * live in a split pane / popout that `activatePanel` cannot bring beside this
 * paper — drop it from state and reopen via the reading placement so it
 * stacks into a visible notes column.
 */
function openNotesForPaper(
	paperId: string,
	paperPatch?: Partial<DocTab>,
	paperPath?: string,
): void {
	const tab = getTabs().find((t) => t.id === paperId);
	const notesPath = paperPatch?.notesPath ?? tab?.notesPath ?? null;
	if (!tab && !paperPath) return;
	const path = paperPath ?? tab?.path ?? "";
	const notesId = notesPath ? tabIdForPath(notesPath) : null;
	const notesTab = notesId
		? (getTabs().find((t) => t.id === notesId) ?? null)
		: null;
	const notesInDock = notesId
		? Boolean(dockHandle()?.canActivatePanel(notesId))
		: false;
	if (notesTab && notesInDock && notesId) {
		dockHandle()?.activatePanel(notesId);
		dockHandle()?.activatePanel(paperId);
		return;
	}
	if (notesTab && notesId) {
		// Drop the unreachable panel from state so the reopen below can
		// register a fresh one under the same id.
		setTabs((prev) => prev.filter((t) => t.id !== notesId));
	}
	const paperLike = {
		...createPlaceholderTab(path, tab?.mode ?? "pdf"),
		...(paperPatch ?? {}),
		...tab,
		notesPath,
	} as DocTab;
	const notesPane = createNotesSplitPane(paperLike);
	if (!notesPane) {
		return;
	}
	const { notes: notesPlacement } = paperReadingPlacements(getTabs(), {
		paperId,
		notesId: notesPane.id,
		activeId: getActiveTabId(),
	});
	setTabs((prev) => {
		if (prev.some((t) => t.id === notesPane.id)) return prev;
		return [...prev, notesPane];
	});
	dockHandle()?.openPanel(notesPane, notesPlacement);
	// Keep focus on the paper body after NOTES joins the right column.
	dockHandle()?.activatePanel(paperId);
}

/**
 * Close a tab; focus stays with dockview; full Library when emptied.
 * Closing a paper body (PDF/HTML) also closes its NOTES companion;
 * closing NOTES leaves the body open.
 */
export function closeTab(id: string, opts: { remember?: boolean } = {}): void {
	// Resolve pair before setState so Strict Mode double-invoke is stable.
	const idsToClose = readingPairCloseIds(getTabs(), id);
	const active = getActiveTabId();
	if (active && idsToClose.includes(active)) {
		notePaperFocus(null);
	}

	if (opts.remember !== false) rememberClosedTabs(idsToClose);

	setTabs((prev) => {
		let next = prev;
		const removedList: DocTab[] = [];
		for (const closeId of idsToClose) {
			const result = removeTab(next, closeId);
			next = result.tabs;
			if (result.removed) removedList.push(result.removed);
		}
		if (!removedList.length) return prev;
		for (const r of removedList) revokeTabMediaSources(r);
		return withLibraryIfEmpty(next);
	});
	removeTabAnnotations(idsToClose);
}

/**
 * Push the panels about to close onto the reopen history (⇧⌘T). Library and
 * Trash are auto-managed, and a NOTES companion is skipped when its paper body
 * closes with it — reopening the body brings NOTES back.
 */
function rememberClosedTabs(idsToClose: readonly string[]): void {
	const tabs = getTabs();
	const closing = idsToClose
		.map((closeId) => tabs.find((t) => t.id === closeId))
		.filter((tab): tab is DocTab => Boolean(tab));
	const companionIds = new Set(
		closing.flatMap((tab) =>
			isPaperContentTab(tab) && tab.notesPath
				? [tabIdForPath(tab.notesPath)]
				: [],
		),
	);
	pushClosedTabs(
		closing
			.filter(
				(tab) =>
					!companionIds.has(tab.id) &&
					!isLibraryVirtualPath(tab.path) &&
					!isTrashVirtualPath(tab.path),
			)
			.map((tab) => ({ path: tab.path, mode: tab.mode })),
	);
}

/** ⇧⌘T — reopen the most recently closed panel that is not already open. */
export function reopenClosedTab(): void {
	for (let entry = takeClosedTab(); entry; entry = takeClosedTab()) {
		const id = tabIdForPath(entry.path);
		if (getTabs().some((tab) => tab.id === id)) continue;
		openTab(entry.path, { preferMode: entry.mode });
		return;
	}
}

/** Close every Plaza overview / source tab. */
export function closePlazaTabs(): void {
	let removedIds: string[] = [];
	setTabs((prev) => {
		const removed = prev.filter(
			(tab) => tab.kind === "plaza" || isPlazaVirtualPath(tab.path),
		);
		if (!removed.length) return prev;
		for (const tab of removed) revokeTabMediaSources(tab);
		removedIds = removed.map((tab) => tab.id);
		const tabs = prev.filter((tab) => !removedIds.includes(tab.id));
		return withLibraryIfEmpty(tabs);
	});
	if (removedIds.length) removeTabAnnotations(removedIds);
}

/** Close every panel whose path is at or under the given path. */
export function closeTabsUnderPath(path: string): void {
	let removedIds: string[] = [];
	setTabs((prev) => {
		const { tabs, removed } = removeTabsUnderPath(prev, path);
		if (!removed.length) return prev;
		for (const t of removed) revokeTabMediaSources(t);
		removedIds = removed.map((t) => t.id);
		return withLibraryIfEmpty(tabs);
	});
	if (removedIds.length) removeTabAnnotations(removedIds);
}

/** Cycle the active panel by dockview visual order (api.panels). */
export function cycleActiveTab(delta: number): void {
	dockHandle()?.cycleActive(delta);
}

function cloneTabForSplit(tab: DocTab, tabs: DocTab[]): DocTab {
	return {
		...tab,
		id: splitPaneIdForPath(
			tab.path,
			tabs.map((candidate) => candidate.id),
		),
	};
}

/** Obsidian-style Split pane: add a right pane and keep columns evenly sized. */
export function splitActivePane(): void {
	const id = getActiveTabId();
	if (!id) return;
	const tabs = getTabs();
	const active = tabs.find((t) => t.id === id);
	if (!active) return;

	const notesId = active.notesPath ? tabIdForPath(active.notesPath) : null;
	const shouldOpenDefaultNotes =
		tabNotesEligible(active) &&
		Boolean(active.notesPath) &&
		notesId != null &&
		!tabs.some((t) => t.id === notesId);

	if (shouldOpenDefaultNotes) {
		const notesPane = createNotesSplitPane(active);
		if (!notesPane) return;
		setTabs((prev) =>
			prev.some((t) => t.id === notesPane.id) ? prev : [...prev, notesPane],
		);
		dockHandle()?.splitPanelRight(notesPane, active.id);
		setActiveTabId(notesPane.id);
		return;
	}

	const splitPane = cloneTabForSplit(active, tabs);
	setTabs((prev) => [...prev, splitPane]);
	dockHandle()?.splitPanelRight(splitPane, active.id);
	setActiveTabId(splitPane.id);
}

/**
 * Open a rendered-translation panel to the right of the referenced paper panel.
 * When dual-pane translation is enabled, the full-document translate button
 * calls this after kicking off the layout translation job.
 */
export function openTranslationTab(
	paperTabId: string,
	paperAbsPath: string | null,
): void {
	if (!paperAbsPath) return;
	const tabs = getTabs();
	const paperTab = tabs.find((t) => t.id === paperTabId);
	if (!paperTab) return;

	const existing = tabs.find(
		(t) => t.id === `${tabIdForPath(paperAbsPath)}::translation`,
	);
	if (existing) {
		dockHandle()?.activatePanel(existing.id);
		return;
	}

	const translationPane = createTranslationSplitPane(paperTab);
	if (!translationPane) return;
	registerScrollSyncPair(paperTabId, translationPane.id);
	// Re-use the source pane's in-memory layout result so the translation pane
	// does not have to re-read the sidecar or re-run layout analysis.
	const sourceLayout = getLayoutDocumentResult(paperTabId);
	if (sourceLayout) {
		setLayoutDocumentResult({
			...sourceLayout,
			documentId: translationPane.id,
		});
	} else if (paperAbsPath) {
		// The source pane hasn't finished writing its result yet (rare race when
		// the user clicks translate immediately after opening the paper). Read the
		// sidecar asynchronously once it lands and seed the right pane so its auto-
		// start translation can begin without a manual layout re-run.
		void (async () => {
			const sidecar = await readLayoutSidecar(paperAbsPath);
			if (!sidecar) return;
			if (getLayoutDocumentResult(translationPane.id)) return;
			const result = buildLayoutDocumentResult(
				translationPane.id,
				mergeCaptionsIntoHosts([...sidecar.regions]),
				sidecar.regions,
			);
			setLayoutDocumentResult(result);
		})();
	}
	setTabs((prev) => [...prev, translationPane]);
	dockHandle()?.splitPanelRight(
		translationPane,
		translationSplitPlacement(paperTabId, tabs).referencePanelId,
	);
}

export function closeWindow(): void {
	if (!isTauri()) return;
	void (async () => {
		try {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			await getCurrentWindow().close();
		} catch {
			// window close unavailable outside the desktop shell
		}
	})();
}

/**
 * ⌘W / File → Close:
 * 1. Top app overlay → dismiss.
 * 2. Else close the active dockview panel.
 * Sole full-library panel → close window.
 */
let lastCloseTabOrWindowAt = 0;

export function closeTabOrWindow(): void {
	const now = Date.now();
	if (now - lastCloseTabOrWindowAt < 80) return;
	lastCloseTabOrWindowAt = now;

	if (closeTopOverlay()) return;

	const list = getTabs();
	const activeId = getActiveTabId() ?? list[list.length - 1]?.id;
	const sole = list.length === 1 ? list[0] : null;
	if (sole && isLibraryVirtualPath(sole.path)) {
		closeWindow();
		return;
	}
	if (list.length > 0) {
		if (activeId) closeTab(activeId);
		return;
	}
	closeWindow();
}

function activeNotesTarget(): DocTab | null {
	const id = getActiveTabId();
	if (!id) return null;
	const tab = getTabs().find((t) => t.id === id);
	// NOTES may be toggled from paper PDF/HTML, or when NOTES panel itself is active.
	const paper =
		tab && tabNotesEligible(tab)
			? tab
			: getTabs().find(
					(t) =>
						tabNotesEligible(t) &&
						t.notesPath &&
						tab?.path &&
						normalizeTabPath(t.notesPath) === normalizeTabPath(tab.path),
				);
	return paper ?? tab ?? null;
}

/** Set the active paper's NOTES panel without touching other PDF tabs. */
export function setNotesSplit(open: boolean): void {
	setLayoutMode("custom");
	const target = activeNotesTarget();
	if (!target?.notesPath) return;
	const notesId = tabIdForPath(target.notesPath);
	const isOpen = tabHasNotesSplit(getTabs(), target);
	if (isOpen === open) {
		if (open) dockHandle()?.equalizeGridGroups();
		return;
	}
	if (!open) {
		closeTab(notesId, { remember: false });
		return;
	}
	if (!tabNotesEligible(target) && target.kind !== "paper") return;
	const notesPane = createNotesSplitPane(target);
	if (!notesPane) return;
	// Stack into the notes column when one exists; else first right split.
	const { notes: notesPlacement } = paperReadingPlacements(getTabs(), {
		paperId: target.id,
		notesId: notesPane.id,
		activeId: getActiveTabId(),
	});
	setTabs((prev) => {
		if (prev.some((t) => t.id === notesPane.id)) return prev;
		return [...prev, notesPane];
	});
	dockHandle()?.openPanel(notesPane, notesPlacement);
	dockHandle()?.equalizeGridGroups();
	setActiveTabId(notesPane.id);
}

/** Toggle NOTES.md panel for the active paper (⌘\ / Layout menu). */
export function toggleNotesSplit(): void {
	const target = activeNotesTarget();
	if (!target) return;
	setNotesSplit(!tabHasNotesSplit(getTabs(), target));
}

/** Open (or focus) the NOTES.md panel of a paper body tab (tab context menu). */
export function openTabNotes(tabId: string): void {
	const target = getTabs().find((t) => t.id === tabId);
	if (!target?.notesPath || !tabNotesEligible(target)) return;
	const notesId = tabIdForPath(target.notesPath);
	if (tabHasNotesSplit(getTabs(), target)) {
		dockHandle()?.activatePanel(notesId);
		setActiveTabId(notesId);
		return;
	}
	const notesPane = createNotesSplitPane(target);
	if (!notesPane) return;
	// Stack into the notes column when one exists; else first right split.
	const { notes: notesPlacement } = paperReadingPlacements(getTabs(), {
		paperId: target.id,
		notesId: notesPane.id,
		activeId: getActiveTabId(),
	});
	setTabs((prev) => {
		if (prev.some((t) => t.id === notesPane.id)) return prev;
		return [...prev, notesPane];
	});
	dockHandle()?.openPanel(notesPane, notesPlacement);
	setActiveTabId(notesPane.id);
}

/** File-tree "Open notes": reading layout with NOTES in the right column. */
export function openPaperNotes(paperDir: string): void {
	const abs = paperDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const existing = getTabs().find((t) => t.id === tabIdForPath(abs));
	if (existing && tabNotesEligible(existing)) {
		setTreeSelectedPath(abs);
		openTabNotes(existing.id);
		return;
	}
	setTreeSelectedPath(abs);
	openTab(abs, { preferMode: "pdf", forceNotes: true });
}

/** Open a paper folder in a tab: center PDF, right Notes (resolved on load).
 *  Also selects/reveals the paper in the left file tree. */
export function openPaper(paperDir: string): void {
	const abs = paperDir.replace(/\\/g, "/").replace(/\/+$/, "");
	setTreeSelectedPath(abs);
	openTab(abs, { preferMode: "pdf" });
}

/** Open an arXiv Daily recommendation as a remote PDF preview (no local files). */
export function openRemoteArxivPaper(item: RemotePaperItem): void {
	stageRemoteArxivPaper(item);
	openTab(remoteArxivPath(item.arxivId), { preferMode: "pdf" });
}

/** Open any path with the mode inferred from its extension. */
export function openPath(absoluteOrDemoPath: string): void {
	openTab(absoluteOrDemoPath, {
		preferMode: preferredModeForPath(absoluteOrDemoPath),
	});
}

/** Open a vault-relative path from backlinks (e.g. `notes/idea.md`). */
export function openVaultRel(rel: string): void {
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("app:errors.openVaultForLinks"));
		return;
	}
	const clean = normalizeVaultRel(rel);
	openPath(joinVaultPath(vaultPath, clean));
}

/** Graph: paper NOTES / paper folder → open paper (PDF + Notes). */
export function openGraphPath(rel: string): void {
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("app:errors.openVaultForGraph"));
		return;
	}
	const clean = normalizeVaultRel(rel);
	const candidate = joinVaultPath(vaultPath, clean);
	// paperFolders are absolute paths from the file tree
	const paperAbs = paperDirFromPath(
		candidate,
		vaultStore.getState().paperFolders,
	);
	if (paperAbs) {
		openPaper(paperAbs);
		return;
	}
	// Collapsed graph node may already be the paper folder rel path
	void (async () => {
		if (await detectPaperDirectory(candidate)) {
			openPaper(candidate);
			return;
		}
		openVaultRel(clean);
	})();
}

let wikiNavigationIntentId = 0;

/** Wait for the PDF handle registration after openPaper, then jump. */
function scheduleAnnotationJump(paperAbs: string, annotationId: string): void {
	const tabId = tabIdForPath(paperAbs);
	let unsubscribe: (() => void) | null = null;
	let timeoutId: number | null = null;
	let finished = false;

	const finish = () => {
		if (finished) return false;
		finished = true;
		unsubscribe?.();
		if (timeoutId !== null) window.clearTimeout(timeoutId);
		return true;
	};

	const jump = (handle: PdfViewerHandle) => {
		if (!finish()) return;
		void lookupAnnotationRef(paperAbs, annotationId).then((ref) => {
			if (!ref) {
				notifyError(
					i18n.t("app:errors.wikiLinkInvalidFragment", {
						target: `@${annotationId}`,
					}),
				);
				return;
			}
			if (ref.kind === "visual" || ref.kind === "agent-trace") {
				handle.scrollToVisualTrace(ref.id);
			} else {
				handle.scrollToHighlight(ref.id);
			}
		});
	};

	const tryJump = () => {
		const handle = pdfHandleFor(tabId);
		if (handle) jump(handle);
	};

	tryJump();
	if (finished) return;
	unsubscribe = subscribePdfHandles(tryJump);
	timeoutId = window.setTimeout(() => {
		finish();
	}, 2000);
}

export async function navigateWiki(nav: WikiNavTarget): Promise<void> {
	const vaultPath = getVaultPath();
	const destination = wikiNavigationDestination(nav);
	if (destination) {
		if (!vaultPath) {
			notifyError(i18n.t("app:errors.openVaultForLinks"));
			return;
		}
		const full = joinVaultPath(vaultPath, normalizeVaultRel(destination.path));

		// Annotation fragments always open the paper PDF unit, not NOTES alone.
		if (destination.fragment?.kind === "annotation") {
			const paperAbs =
				paperDirFromPath(full, vaultStore.getState().paperFolders) ??
				paperAbsFromWikiTarget(vaultPath, destination.path);
			openPaper(paperAbs);
			const intent = {
				id: ++wikiNavigationIntentId,
				fragment: destination.fragment,
			};
			setTabs((previous) =>
				patchTab(previous, tabIdForPath(paperAbs), {
					navigationIntent: intent,
				}),
			);
			if (destination.warning === "invalidFragment") {
				setTabs((previous) =>
					patchTab(previous, tabIdForPath(paperAbs), {
						navigationIntent: undefined,
					}),
				);
				notifyError(
					i18n.t("app:errors.wikiLinkInvalidFragment", {
						target: nav.targetRaw,
					}),
				);
				return;
			}
			scheduleAnnotationJump(paperAbs, destination.fragment.id);
			return;
		}

		openTab(full, { preferMode: preferredModeForPath(full) });
		if (destination.fragment) {
			const intent = {
				id: ++wikiNavigationIntentId,
				fragment: destination.fragment,
			};
			setTabs((previous) =>
				patchTab(previous, tabIdForPath(full), { navigationIntent: intent }),
			);
		}
		if (destination.warning === "invalidFragment") {
			setTabs((previous) =>
				patchTab(previous, tabIdForPath(full), {
					navigationIntent: undefined,
				}),
			);
			notifyError(
				i18n.t("app:errors.wikiLinkInvalidFragment", { target: nav.targetRaw }),
			);
		}
		return;
	}
	if (nav.status === "ambiguous") {
		notifyError(
			i18n.t("app:errors.wikiLinkAmbiguous", { target: nav.targetRaw }),
		);
		return;
	}
	if (nav.status === "invalidFragment") {
		notifyError(
			i18n.t("app:errors.wikiLinkInvalidFragment", { target: nav.targetRaw }),
		);
		return;
	}
	if (!vaultPath) {
		notifyError(i18n.t("app:errors.openVaultForCreate"));
		return;
	}
	const createRel = missingNotePath(nav.targetRaw);
	const ok = window.confirm(
		i18n.t("app:confirm.createNote", {
			target: nav.targetRaw,
			path: createRel,
		}),
	);
	if (!ok) return;

	const content = newNoteMarkdown(nav.targetRaw);
	const full = joinVaultPath(vaultPath, createRel);

	try {
		await writeVaultFile(full, content);
		await rebuildWikiAndNotify(vaultPath);
		await refreshTree(vaultPath);
		openPath(full);
	} catch (e) {
		notifyError(errorText(e));
	}
}

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
/** Serialize Markdown saves per absolute path so overlapping editor lifecycles
 * cannot race their disk snapshot checks and writes. */
const markdownPersistQueues = new Map<string, Promise<boolean>>();

/**
 * Reload an open editor when its file changed on disk (external editor /
 * Agent). Reseeds only when disk content differs from the current seed —
 * equal content means it was our own autosave. The mounted editor reloads the
 * new seed in place (no remount); the path is guarded briefly so a racing
 * autosave cannot overwrite the fresh disk text.
 */
export async function applyDiskChange(absPath: string): Promise<void> {
	const norm = normalizeTabPath(absPath);
	const openTabs = getTabs();
	const notesOwners = openTabs.filter(
		(t) => t.notesPath && normalizeTabPath(t.notesPath) === norm,
	);
	const mdOwners = openTabs.filter(
		(t) => normalizeTabPath(t.path) === norm && isMarkdownPath(t.path),
	);
	if (!notesOwners.length && !mdOwners.length) return;
	let content: string;
	try {
		content = await readVaultFile(absPath);
	} catch {
		return;
	}
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
	for (const notesTab of notesOwners) {
		if (content === notesTab.notesSeed) continue;
		const paperDir = absPath.replace(/[\\/]NOTES\.md$/i, "");
		const reload = () => {
			guard();
			refreshTabNotes(paperDir, content);
		};
		if (notesTab.notesDirty) promptReload(reload);
		else reload();
	}
	for (const mdTab of mdOwners) {
		if (content === mdTab.markdownSeed) continue;
		const reload = () => {
			guard();
			refreshTabMarkdown(absPath, content);
		};
		if (mdTab.markdownDirty) promptReload(reload);
		else reload();
	}
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
): Promise<boolean> {
	if (!isTauri() || !getVaultPath() || !path) return Promise.resolve(false);
	const normalizedPath = normalizeTabPath(path);
	const previous =
		markdownPersistQueues.get(normalizedPath) ?? Promise.resolve(false);
	const attempt = previous
		.catch(() => false)
		.then(async () => {
			// Skip while this path is being reloaded from disk (external/Agent
			// write): the unmount-flush must not clobber the fresh disk content.
			if (reseedGuard.has(normalizedPath)) return false;
			// Conflict guard: if the file changed on disk since we last saved,
			// do NOT silently overwrite — keep the user's in-memory edit and warn.
			try {
				const disk = await readVaultFile(path);
				if (disk !== lastSaved) {
					const name = path.split(/[\\/]/).pop() ?? path;
					notifyWarning(i18n.t("app:diskConflict.saveBlocked", { name }));
					return false;
				}
			} catch {
				// Missing/unreadable file → no conflict to guard against.
			}
			try {
				await writeVaultFile(path, md);
				// The watcher echo of this write must not re-trigger a full Wiki
				// rebuild on every autosave (#270).
				trackSelfWrittenPath(path);
				// Advance the owning tab's seed only after the write is confirmed.
				setTabs((prev) => syncTabSeedsForPath(prev, path, md));
				return true;
			} catch (e) {
				notifyError(errorText(e));
				return false;
			}
		});
	markdownPersistQueues.set(normalizedPath, attempt);
	void attempt.then(
		() => {
			if (markdownPersistQueues.get(normalizedPath) === attempt) {
				markdownPersistQueues.delete(normalizedPath);
			}
		},
		() => {
			if (markdownPersistQueues.get(normalizedPath) === attempt) {
				markdownPersistQueues.delete(normalizedPath);
			}
		},
	);
	return attempt;
}

/** Ensure the strip shows the full Library when it would otherwise be empty. */
export function ensureLibraryTabPresent(): void {
	if (getTabs().length > 0) return;
	const ensured = ensureFullLibraryTab([]);
	setTabs(ensured.tabs);
	setActiveTabId(ensured.activeId);
}

const placeholderLoads = new Set<string>();

/** Load resources for restored panels only when their dock group exposes them. */
export function hydratePlaceholderTabs(tabIds: readonly string[]): void {
	if (!isTauri() || !getVaultPath()) return;
	if (!getTabs().length) {
		ensureLibraryTabPresent();
		return;
	}
	for (const id of new Set(tabIds)) {
		const tab = getTabs().find((candidate) => candidate.id === id);
		if (!tab || tab.loaded || placeholderLoads.has(id)) continue;
		placeholderLoads.add(id);
		void (async () => {
			const vaultState = vaultStore.getState();
			try {
				const res = await loadTabResources(
					tab.path,
					vaultState.vaultPath,
					vaultState.tree,
					vaultState.paperFolders,
				);
				const current = getTabs().find((candidate) => candidate.id === id);
				if (
					!current ||
					current.path !== tab.path ||
					vaultStore.getState().vaultPath !== vaultState.vaultPath
				) {
					return;
				}
				if (res.error) {
					notifyError(
						res.error === "cannotPreview"
							? i18n.t("app:errors.cannotPreview", {
									name: basenameOf(tab.path),
								})
							: res.error,
					);
				}
				updateTab(id, {
					kind: res.kind,
					title: res.title,
					mode: res.mode,
					paperMeta: res.paperMeta,
					pdfUrl: res.pdfUrl,
					pdfBytes: res.pdfBytes ?? null,
					htmlUrl: res.htmlUrl,
					imageUrl: res.imageUrl,
					notesPath: res.notesPath,
					notesSeed: res.notesSeed,
					markdownSeed: res.markdownSeed,
					seedKey: 1,
					loaded: true,
				});
				// A restored paper body hydrates after its NOTES panel was
				// pruned from the layout — open the companion now, otherwise
				// the first click shows the PDF without notes beside it.
				if (
					res.kind === "paper" &&
					(res.mode === "pdf" || res.mode === "html") &&
					res.notesPath &&
					loadSettings().autoOpenPaperNotes
				) {
					openNotesForPaper(id);
				}
			} finally {
				placeholderLoads.delete(id);
			}
		})();
	}
}

/** Library tree node: full library scope, single Library tab. */
export function selectLibrary(): void {
	setTreeSelectedPath(LIBRARY_VIRTUAL_PATH);
	setLibraryScopePath(null);
	openTab(LIBRARY_VIRTUAL_PATH);
	void refreshLibrary();
}

export function selectTrash(): void {
	setTreeSelectedPath(TRASH_VIRTUAL_PATH);
	openTab(TRASH_VIRTUAL_PATH);
}

/** Open one Plaza source panel (from its tree child row). */
export function openPlazaSource(source: PlazaSource): void {
	if (!loadSettings().plazaEnabled) return;
	setTreeSelectedPath(source.path);
	openTab(source.path);
}

/**
 * Org folder click: expand happens in the tree; center shows the same Library
 * tab filtered by path prefix — never opens a new tab for the folder.
 * Only `papers/` (and subfolders) become a scope; notes/.agents/plans etc.
 * show the full library (#160).
 */
export function openFolderLibrary(folderAbs: string): void {
	const abs = folderAbs.replace(/\\/g, "/").replace(/\/+$/, "");
	setTreeSelectedPath(abs);
	const vault = getVaultPath();
	const rel = vault
		? toVaultRelative(vault, abs)
				.replace(/\\/g, "/")
				.replace(/^\/+|\/+$/g, "")
		: "";
	setLibraryScopePath(resolveLibraryScopePath(rel || null));
	// Reuse / focus the single full-library tab only.
	openTab(LIBRARY_VIRTUAL_PATH);
}

/** File-tree click dispatch: Library / Trash / Plaza / paper dir / org dir / file. */
export function selectFileNode(node: FileNode): void {
	if (isLibraryVirtualPath(node.path)) {
		selectLibrary();
		return;
	}
	if (isTrashVirtualPath(node.path)) {
		selectTrash();
		return;
	}
	if (isPlazaVirtualPath(node.path)) {
		if (!loadSettings().plazaEnabled) return;
		// The Plaza root is a plain folder; only source children open a tab.
		const source = plazaSourceForPath(node.path);
		if (source) openPlazaSource(source);
		return;
	}
	if (node.kind === "directory" && isPaperDirectory(node.path, node.children)) {
		openPaper(node.path);
		return;
	}
	if (node.kind === "directory") {
		const paperAbs = paperDirFromPath(
			node.path,
			vaultStore.getState().paperFolders,
		);
		// Folders inside `{paper}/attachments/` are files, not Library scopes.
		if (paperAbs && isUnderPaperAttachments(node.path, paperAbs)) {
			setTreeSelectedPath(node.path);
			return;
		}
		// Org / plain folders → in-place scope on the Library tab (no new tab).
		openFolderLibrary(node.path);
		return;
	}
	if (node.kind !== "file") return;
	openPath(node.path);
}
