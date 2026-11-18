import { markdownEditorFor } from "@/lib/workspace/viewer/markdown-editor-registry";
/**
 * Tab open/close, paper+NOTES pairing, and library / file-tree selection.
 */

import i18n from "@/i18n";
import { notePaperFocus, track } from "@/lib/activity";
import { isZenVirtualPath, ZEN_VIRTUAL_PATH } from "@/lib/agent/zen-path";
import { closeZenWorkspace, seedZenFromRail } from "@/lib/agent/zen-store";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { closeTopOverlay } from "@/lib/core/overlay-stack";
import { isTauri } from "@/lib/core/tauri";
import { decideSync, registerDecision } from "@/lib/decision/registry";
import { lifecycle } from "@/lib/lifecycle";
import {
	isPaperDirectory,
	isRemoteArxivPath,
	isUnderPaperAttachments,
	isUnderPapers,
	notesPathForPaper,
	type PaperMetadata,
	paperDirFromPath,
	type RemotePaperItem,
	remoteArxivPath,
	retainViewerSource,
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
	remapTabAnnotations,
	removeTabAnnotations,
} from "@/lib/pdf/annotations-store";
import { cancelPdfNavigationForTab } from "@/lib/pdf/pending-pdf-page";
import {
	isPlazaVirtualPath,
	type PlazaSource,
	plazaSourceForPath,
} from "@/lib/plaza";
import { loadSettings } from "@/lib/settings";
import { closeCurrentWindow } from "@/lib/shell/close-window";
import { layout, setLayoutMode, uiStore } from "@/lib/shell/ui-store";
import { type FileNode, joinVaultPath } from "@/lib/vault";
import {
	isVaultAgentRoot,
	isVaultSkillDirectory,
	skillMarkdownPath,
} from "@/lib/vault/agent-tree";
import {
	getVaultPath,
	refreshTree,
	setTreeSelectedPath,
	vaultStore,
} from "@/lib/vault/store";
import { toVaultRelative } from "@/lib/wiki";
import {
	cacheActiveTabBeforeDock,
	dockHandle,
} from "@/lib/workspace/dock-registry";
import { vaultLoadGeneration } from "@/lib/workspace/identity";
import {
	getActiveTabId,
	getTabs,
	pushClosedTabs,
	setActiveTabId,
	setTabs,
	takeClosedTab,
	updateTab,
} from "@/lib/workspace/store";
import {
	isWritingPath,
	resolveWritingTarget,
} from "@/lib/writing/project-target";
import { applyDiskChange } from "./persistence";
import {
	basenameOf,
	createNotesSplitPane,
	createPlaceholderTab,
	type DocTab,
	ensureFullLibraryTab,
	findCanonicalTab,
	findNotesPaneForReplacement,
	insertPlaceholderTab,
	isCanonicalView,
	isPaperContentTab,
	loadTabResources,
	normalizeTabPath,
	type OpenPlacement,
	paperReadingPlacements,
	patchFromTabResources,
	type ReadingColumns,
	readingPairCloseIds,
	remapPathUnder,
	remapTabsUnderPath,
	removeTab,
	removeTabsUnderPath,
	revokeTabMediaSources,
	splitPaneIdForPath,
	tabHasNotesSplit,
	tabIsPaperNoteDocument,
	tabIsPaperNotes,
	tabNotesEligible,
	tabTitleForPath,
} from "./tabs";
import { flushTextEditorFor } from "./text-editor-flush";
import { type CenterViewMode, preferredModeForPath } from "./viewer";

/**
 * Library is resident: with a Vault open its tab must always exist in the
 * strip. Active focus is left to dockview (`onDidActivePanelChange` / sync end).
 */
function withLibraryPresent(next: DocTab[]): DocTab[] {
	if (!getVaultPath()) return next;
	return ensureFullLibraryTab(next).tabs;
}

/** Put Library on the dock. `inactive` keeps the document the user is reading. */
function showLibraryPanel(library: DocTab, inactive: boolean): void {
	if (!inactive) {
		cacheActiveTabBeforeDock(library.id);
		dockHandle()?.activatePanel(library.id);
	}
	dockHandle()?.openPanel(
		library,
		undefined,
		inactive ? { inactive: true } : undefined,
	);
}

/** Drop closed panels, and place Library if this update just inserted it. */
function detachClosedPanels(
	before: readonly DocTab[],
	removedIds: readonly string[],
): void {
	for (const id of removedIds) dockHandle()?.removePanel(id);
	const library = getTabs().find((tab) => isLibraryVirtualPath(tab.path));
	if (!library || before.some((tab) => tab.id === library.id)) return;
	const activeId = getActiveTabId();
	const keptActiveDocument = Boolean(
		activeId && !removedIds.includes(activeId),
	);
	const otherDocument = getTabs().some(
		(tab) => !isLibraryVirtualPath(tab.path),
	);
	showLibraryPanel(library, keptActiveDocument || otherDocument);
}

/**
 * Suppress companion-tab sync while we programmatically flip paper+NOTES
 * (avoids onActivePanelChange recursion).
 */
let readingSync = false;

/**
 * Anchors of the standard two-column reading layout, or null when the dock is
 * not showing exactly two side-by-side columns.
 */
function readingColumns(): ReadingColumns | null {
	return dockHandle()?.readingColumns() ?? null;
}

/**
 * Bring a paper body panel to front; if its NOTES panel is already open,
 * activate that tab in the notes column too (focus ends on the paper).
 */
export function activatePaperWithNotes(paperTab: DocTab): void {
	const notesId = paperTab.notesPath
		? (findCanonicalTab(getTabs(), paperTab.notesPath)?.id ?? null)
		: null;
	const notesOpen = notesId != null;
	readingSync = true;
	try {
		// Activate NOTES first so its group shows the matching tab; then paper
		// so focus/active id land on the body panel.
		if (notesOpen && notesId) {
			dockHandle()?.activatePanel(notesId, { skipSetGroupActive: true });
		}
		dockHandle()?.activatePanel(paperTab.id);
		if (
			uiStore.getState().layoutMode === "reading" &&
			!dockHandle()?.isMaximizedPanel?.()
		) {
			dockHandle()?.maximizeActivePanel?.();
		}
	} finally {
		queueMicrotask(() => {
			readingSync = false;
		});
	}
	// `activatePanel` does not set `syncingRef`, so the paper activation
	// reaches `handleActivePanelChange` and leaves focus on the body.
	cacheActiveTabBeforeDock(paperTab.id);
}

/** Paper folder whose body, translation, or notes pane is allowed to count. */
function readingPathForTab(tab: DocTab | null): string | null {
	if (!tab) return null;
	if (
		isLibraryVirtualPath(tab.path) ||
		isTrashVirtualPath(tab.path) ||
		isZenVirtualPath(tab.path) ||
		isRemoteArxivPath(tab.path) ||
		isPlazaVirtualPath(tab.path)
	) {
		return null;
	}
	if (tab.pane === "translation" || isPaperContentTab(tab)) return tab.path;
	if (tabIsPaperNoteDocument(tab)) {
		return paperDirFromPath(tab.notesPath ?? tab.path);
	}
	return null;
}

/** Path of the paper currently in front, if the active pane is one of its views. */
export function activeReadingPath(): string | null {
	const id = getActiveTabId();
	if (!id) return null;
	return readingPathForTab(getTabs().find((tab) => tab.id === id) ?? null);
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
	if (!tab) {
		notePaperFocus(null);
		return;
	}
	notePaperFocus(readingPathForTab(tab));

	if (isPaperContentTab(tab) && tab.notesPath) {
		const notesId = findCanonicalTab(getTabs(), tab.notesPath)?.id ?? null;
		if (!notesId) return;
		readingSync = true;
		try {
			dockHandle()?.activatePanel(notesId, { skipSetGroupActive: true });
			dockHandle()?.activatePanel(panelId);
			if (
				uiStore.getState().layoutMode === "reading" &&
				!dockHandle()?.isMaximizedPanel()
			) {
				dockHandle()?.maximizeActivePanel();
			}
		} finally {
			queueMicrotask(() => {
				readingSync = false;
			});
		}
		return;
	}

	if (tabIsPaperNotes(tab) && isCanonicalView(tab)) {
		const notesKey = normalizeTabPath(tab.path);
		const companion = getTabs().find(
			(t) =>
				isPaperContentTab(t) &&
				isCanonicalView(t) &&
				t.notesPath &&
				normalizeTabPath(t.notesPath) === notesKey,
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
		/**
		 * Replace this notes panel in place instead of adding another tab.
		 * Used when the reading layout already shows a notes column and the
		 * user opens another note.
		 */
		replaceNotesPaneId?: string | null;
	},
): void {
	const existing = findCanonicalTab(getTabs(), path);
	if (existing) {
		const id = existing.id;
		// Sync paper + NOTES tabs when re-opening an already-mounted paper.
		if (
			existing.kind === "paper" &&
			(existing.mode === "pdf" || existing.mode === "html")
		) {
			const wantDefaultNotes =
				!opts?.skipDefaultNotes &&
				!opts?.placement &&
				Boolean(existing.notesPath) &&
				(opts?.forceNotes || loadSettings().autoOpenPaperNotes);
			if (wantDefaultNotes && !tabHasNotesSplit(getTabs(), existing)) {
				if (uiStore.getState().layoutMode !== "reading") {
					openTabNotes(existing.id);
				}
			}
			activatePaperWithNotes(existing);
		} else {
			cacheActiveTabBeforeDock(id);
			dockHandle()?.activatePanel(id);
		}
		return;
	}

	const replaceId = opts?.replaceNotesPaneId ?? null;
	const candidate =
		replaceId != null
			? (getTabs().find((t) => t.id === replaceId) ?? null)
			: null;
	// Only replace a panel this dock can actually see; unreachable restored
	// panes fall back to a normal open.
	const replaced =
		candidate && dockHandle()?.canActivatePanel(candidate.id) === true
			? candidate
			: null;

	const beforeTabs = replaced
		? getTabs().filter((t) => t.id !== replaced.id)
		: getTabs();
	const { tabs: nextTabs, id: insertedId } = insertPlaceholderTab(
		beforeTabs,
		path,
		opts?.preferMode,
	);
	const placeholder =
		nextTabs.find((t) => t.id === insertedId) ??
		createPlaceholderTab(path, opts?.preferMode);

	// Paper bodies join the left column of an existing two-column reading layout;
	// otherwise free dock placement keeps multi-paper splits working. NOTES still
	// prefers the right (notes) column when present.
	const initialPlacement = replaced
		? null
		: (opts?.placement ??
			paperReadingPlacements(beforeTabs, {
				paperId: insertedId,
				activeId: getActiveTabId(),
				columns: readingColumns(),
			}).paper);

	setTabs(nextTabs);
	cacheActiveTabBeforeDock(insertedId);
	if (replaced) {
		dockHandle()?.remapPanel(replaced.id, placeholder);
		dockHandle()?.activatePanel(insertedId);
	} else {
		dockHandle()?.openPanel(placeholder, initialPlacement);
	}

	void (async () => {
		const vaultState = vaultStore.getState();
		const generation = vaultLoadGeneration();
		const res = await loadTabResources(
			path,
			vaultState.vaultPath,
			vaultState.tree,
			vaultState.paperFolders,
		);
		if (vaultLoadGeneration() !== generation) return;
		if (res.error) {
			notifyError(
				res.error === "cannotPreview"
					? i18n.t("app:errors.cannotPreview", { name: basenameOf(path) })
					: res.error,
			);
		}
		// Guard against a transient PDF-probe miss with the placeholder's
		// preferMode (⇧⌘T reopen of a closed PDF tab), not `existing` — an
		// existing tab returned early above and is never patched here.
		const patch = patchFromTabResources(res, placeholder);
		updateTab(insertedId, patch);

		// Paper default: NOTES in the notes column (or first-time right split).
		const wantDefaultNotes =
			!opts?.skipDefaultNotes &&
			!opts?.placement &&
			res.kind === "paper" &&
			Boolean(res.notesPath) &&
			(patch.mode === "pdf" || patch.mode === "html") &&
			(opts?.forceNotes || loadSettings().autoOpenPaperNotes);
		if (wantDefaultNotes && res.notesPath) {
			openNotesForPaper(insertedId, patch, path);
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
			notePaperFocus(
				res.kind === "paper" && (res.mode === "pdf" || res.mode === "html")
					? path
					: null,
			);
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
	const notesTab = notesPath
		? (findCanonicalTab(getTabs(), notesPath) ?? null)
		: null;
	const notesId = notesTab?.id ?? null;
	const notesInDock = notesId
		? Boolean(dockHandle()?.canActivatePanel(notesId))
		: false;
	if (notesTab && notesInDock && notesId) {
		dockHandle()?.activatePanel(notesId, { skipSetGroupActive: true });
		dockHandle()?.activatePanel(paperId);
		if (
			uiStore.getState().layoutMode === "reading" &&
			!dockHandle()?.isMaximizedPanel?.()
		) {
			dockHandle()?.maximizeActivePanel?.();
		}
		return;
	}
	if (notesTab && notesId) {
		// Drop the unreachable panel from state so the reopen below can
		// register a fresh one under the same id.
		setTabs((prev) => prev.filter((t) => t.id !== notesId));
	}
	const paperLike = {
		...createPlaceholderTab(path, tab?.mode ?? "pdf", tab?.id ?? paperId),
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
		columns: readingColumns(),
	});
	setTabs((prev) => {
		if (prev.some((t) => t.id === notesPane.id)) return prev;
		return [...prev, notesPane];
	});
	dockHandle()?.openPanel(notesPane, notesPlacement);
	// Keep focus on the paper body after NOTES joins the right column.
	dockHandle()?.activatePanel(paperId);
	if (
		uiStore.getState().layoutMode === "reading" &&
		!dockHandle()?.isMaximizedPanel?.()
	) {
		dockHandle()?.maximizeActivePanel?.();
	}
}

/**
 * Close a tab; focus stays with dockview; full Library when emptied.
 * Closing a paper body (PDF/HTML) also closes its NOTES companion;
 * closing NOTES leaves the body open.
 */
export function closeTab(id: string, opts: { remember?: boolean } = {}): void {
	// Library is resident — never closable (its close affordance is hidden).
	const target = getTabs().find((t) => t.id === id);
	if (target && isLibraryVirtualPath(target.path)) return;
	// Resolve pair before setState so Strict Mode double-invoke is stable.
	const idsToClose = readingPairCloseIds(getTabs(), id);
	const pending = idsToClose
		.map(markdownEditorFor)
		.filter((handle) => handle?.hasPendingSource());
	if (pending.length) {
		void Promise.all(pending.map((handle) => handle?.flushSource())).then(
			(saved) => {
				if (saved.every(Boolean)) closeTab(id, opts);
			},
		);
		return;
	}
	const active = getActiveTabId();
	if (active && idsToClose.includes(active)) {
		notePaperFocus(null);
	}

	if (opts.remember !== false) rememberClosedTabs(idsToClose);

	const before = getTabs();
	const removedIds: string[] = [];
	setTabs((prev) => {
		let next = prev;
		const removedList: DocTab[] = [];
		for (const closeId of idsToClose) {
			const result = removeTab(next, closeId);
			next = result.tabs;
			if (result.removed) removedList.push(result.removed);
		}
		if (!removedList.length) return prev;
		removedIds.push(...removedList.map((tab) => tab.id));
		for (const r of removedList) revokeTabMediaSources(r);
		return withLibraryPresent(next);
	});
	detachClosedPanels(before, removedIds);
	for (const closeId of idsToClose) cancelPdfNavigationForTab(closeId);
	removeTabAnnotations(idsToClose);
	if (target && isZenVirtualPath(target.path)) closeZenWorkspace();
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
			readingPairCloseIds(tabs, tab.id).filter((closeId) => closeId !== tab.id),
		),
	);
	pushClosedTabs(
		closing
			.filter(
				(tab) =>
					!companionIds.has(tab.id) &&
					!isLibraryVirtualPath(tab.path) &&
					!isTrashVirtualPath(tab.path) &&
					!isZenVirtualPath(tab.path),
			)
			.map((tab) => ({
				path: tab.path,
				mode: tab.mode,
				...(tab.writingRoot ? { writingRoot: tab.writingRoot } : {}),
			})),
	);
}

/** ⇧⌘T — reopen the most recently closed panel that is not already open. */
export function reopenClosedTab(): void {
	for (let entry = takeClosedTab(); entry; entry = takeClosedTab()) {
		if (findCanonicalTab(getTabs(), entry.path)) continue;
		// A writing source reopens inside its project panel; a plain tab would
		// render a second source/PDF frame for the same project.
		if (entry.writingRoot) {
			openWritingSource(entry.path, entry.writingRoot);
			return;
		}
		openTab(entry.path, { preferMode: entry.mode });
		return;
	}
}

/** Close every Plaza overview / source tab. */
export function closePlazaTabs(): void {
	const before = getTabs();
	let removedIds: string[] = [];
	setTabs((prev) => {
		const removed = prev.filter(
			(tab) => tab.kind === "plaza" || isPlazaVirtualPath(tab.path),
		);
		if (!removed.length) return prev;
		for (const tab of removed) revokeTabMediaSources(tab);
		removedIds = removed.map((tab) => tab.id);
		const tabs = prev.filter((tab) => !removedIds.includes(tab.id));
		return withLibraryPresent(tabs);
	});
	detachClosedPanels(before, removedIds);
	if (removedIds.length) removeTabAnnotations(removedIds);
}

/**
 * Preserve mounted workspace state when a filesystem path changes identity.
 * Works for a single file and for a tree (a paper folder and everything under
 * it), keeping dockview panels, tab ids, annotations, tree selection, and the
 * Library scope pointed at the new path.
 */
export function remapMovedWorkspacePaths(
	fromAbs: string,
	toAbs: string,
	fromRel: string,
	toRel: string,
): void {
	const previousTabs = getTabs();
	const remappedTabs = remapTabsUnderPath(
		previousTabs,
		fromAbs,
		toAbs,
		fromRel,
		toRel,
	);
	for (let index = 0; index < previousTabs.length; index++) {
		const previous = previousTabs[index];
		const remapped = remappedTabs[index];
		if (!previous || !remapped || previous === remapped) continue;
		dockHandle()?.remapPanel(previous.id, remapped);
	}
	const active = previousTabs.find((tab) => tab.id === getActiveTabId());
	if (active) {
		// The view id does not follow the path. Dockview keeps the same panel
		// and only receives the updated path params.
		cacheActiveTabBeforeDock(active.id);
	}
	const annotationMoves = previousTabs.flatMap((tab, index) => {
		const next = remappedTabs[index];
		if (!next || next.id === tab.id) return [];
		return [{ fromId: tab.id, toId: next.id }];
	});
	if (annotationMoves.length) remapTabAnnotations(annotationMoves);
	setTabs(remappedTabs);
	setTreeSelectedPath((path) =>
		path ? remapPathUnder(path, fromAbs, toAbs) : path,
	);
	setLibraryScopePath((scope) =>
		scope ? remapPathUnder(scope, fromRel, toRel) : scope,
	);
	for (const [root, source] of [...recentWritingFiles]) {
		const nextRoot = remapPathUnder(root, fromAbs, toAbs);
		const nextSource = remapPathUnder(source, fromAbs, toAbs);
		if (nextRoot === root && nextSource === source) continue;
		recentWritingFiles.delete(root);
		recentWritingFiles.set(nextRoot, nextSource);
	}
}

/** Close every panel whose path is at or under the given path. */
export function closeTabsUnderPath(path: string): void {
	const before = getTabs();
	let removedIds: string[] = [];
	setTabs((prev) => {
		const { tabs, removed } = removeTabsUnderPath(prev, path);
		if (!removed.length) return prev;
		for (const t of removed) revokeTabMediaSources(t);
		removedIds = removed.map((t) => t.id);
		return withLibraryPresent(tabs);
	});
	detachClosedPanels(before, removedIds);
	for (const removedId of removedIds) cancelPdfNavigationForTab(removedId);
	if (removedIds.length) removeTabAnnotations(removedIds);
}

/** Cycle the active panel by dockview visual order (api.panels). */
export function cycleActiveTab(delta: number): void {
	dockHandle()?.cycleActive(delta);
}

/** Cycle tabs inside the active dock group only (the group's tab bar). */
export function cycleActiveGroupTab(delta: number): void {
	dockHandle()?.cycleGroupTab(delta);
}

export function cloneTabForSplit(tab: DocTab, tabs: DocTab[]): DocTab {
	// Shallow copy shares pdfBytes; each viewer slices before the worker
	// transfer. Blob URLs are not created again, so this pane takes its own lease.
	retainViewerSource(tab.pdfUrl);
	retainViewerSource(tab.imageUrl);
	return {
		...tab,
		id: splitPaneIdForPath(
			tab.path,
			tabs.map((candidate) => candidate.id),
		),
		pane: "split",
	};
}

export function closeWindow(): void {
	closeCurrentWindow();
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
export function setNotesSplit(
	open: boolean,
	opts: { preserveLayoutMode?: boolean } = {},
): void {
	if (!opts.preserveLayoutMode) setLayoutMode("custom");
	const target = activeNotesTarget();
	if (!target?.notesPath) return;
	const notesId = findCanonicalTab(getTabs(), target.notesPath)?.id ?? null;
	const isOpen = tabHasNotesSplit(getTabs(), target);
	if (isOpen === open) return;
	if (!open) {
		if (!notesId) return;
		dockHandle()?.rememberNotesSplitWidth(target.id, notesId);
		closeTab(notesId, { remember: false });
		return;
	}
	if (dockHandle()?.isMaximizedPanel?.()) {
		dockHandle()?.exitMaximizedPanel?.();
	}
	if (!tabNotesEligible(target) && target.kind !== "paper") return;
	const notesPane = createNotesSplitPane(target);
	if (!notesPane) return;
	// Stack into the notes column when one exists; else first right split.
	const { notes: notesPlacement } = paperReadingPlacements(getTabs(), {
		paperId: target.id,
		notesId: notesPane.id,
		activeId: getActiveTabId(),
		columns: readingColumns(),
	});
	setTabs((prev) => {
		if (prev.some((t) => t.id === notesPane.id)) return prev;
		return [...prev, notesPane];
	});
	cacheActiveTabBeforeDock(notesPane.id);
	dockHandle()?.openPanel(notesPane, notesPlacement);
	if (notesPlacement?.direction === "right") {
		dockHandle()?.restoreNotesSplitWidth(target.id, notesPane.id);
	}
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
	const notesId = findCanonicalTab(getTabs(), target.notesPath)?.id ?? null;
	if (dockHandle()?.isMaximizedPanel?.()) {
		dockHandle()?.exitMaximizedPanel?.();
	}
	if (notesId && tabHasNotesSplit(getTabs(), target)) {
		cacheActiveTabBeforeDock(notesId);
		dockHandle()?.activatePanel(notesId);
		return;
	}
	const notesPane = createNotesSplitPane(target);
	if (!notesPane) return;
	// Stack into the notes column when one exists; else first right split.
	const { notes: notesPlacement } = paperReadingPlacements(getTabs(), {
		paperId: target.id,
		notesId: notesPane.id,
		activeId: getActiveTabId(),
		columns: readingColumns(),
	});
	setTabs((prev) => {
		if (prev.some((t) => t.id === notesPane.id)) return prev;
		return [...prev, notesPane];
	});
	cacheActiveTabBeforeDock(notesPane.id);
	dockHandle()?.openPanel(notesPane, notesPlacement);
}

/** File-tree "Open notes": reading layout with NOTES in the right column. */
export function openPaperNotes(paperDir: string): void {
	const abs = paperDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const existing = findCanonicalTab(getTabs(), abs);
	if (existing && tabNotesEligible(existing)) {
		setTreeSelectedPath(abs);
		openTabNotes(existing.id);
		return;
	}
	setTreeSelectedPath(abs);
	openTab(abs, { preferMode: "pdf", forceNotes: true });
}

/** Open a paper folder in a tab: center PDF, right Notes (resolved on load).
 *  By default also selects/reveals the paper in the physical file tree. */
export function openPaper(
	paperDir: string,
	options?: { revealTree?: boolean },
): void {
	const abs = paperDir.replace(/\\/g, "/").replace(/\/+$/, "");
	if (options?.revealTree !== false) setTreeSelectedPath(abs);
	if (loadSettings().replaceCurrentTabOnOpenPaper) {
		const activeId = getActiveTabId();
		const activeTab = activeId
			? getTabs().find((t) => t.id === activeId)
			: null;
		if (
			activeTab &&
			!isLibraryVirtualPath(activeTab.path) &&
			!findCanonicalTab(getTabs(), abs)
		) {
			closeTab(activeTab.id, { remember: false });
		}
	}
	openTab(abs, { preferMode: "pdf" });
}

/** Open an arXiv Daily recommendation as a remote PDF preview (no local files). */
export function openRemoteArxivPaper(item: RemotePaperItem): void {
	stageRemoteArxivPaper(item);
	openTab(remoteArxivPath(item.arxivId), { preferMode: "pdf" });
}

/** Open any path with the mode inferred from its extension. */
export function openPath(absoluteOrDemoPath: string): void {
	const preferMode = preferredModeForPath(absoluteOrDemoPath);
	// Reading layout: a note clicked while a notes pane is open replaces that
	// pane instead of stacking another note tab in the same column.
	const replaceNotes =
		preferMode === "markdown" && isUnderPapers(absoluteOrDemoPath)
			? findNotesPaneForReplacement(getTabs(), getActiveTabId())
			: null;
	openTab(absoluteOrDemoPath, {
		preferMode,
		replaceNotesPaneId: replaceNotes?.id,
	});
}

/** Ensure the resident Library tab exists (no-op when already present). */
export function ensureLibraryTabPresent(): void {
	const ensured = ensureFullLibraryTab(getTabs());
	if (!ensured.inserted) return;
	setTabs(ensured.tabs);
	const library = ensured.tabs.find((tab) => tab.id === ensured.activeId);
	if (!library) return;
	showLibraryPanel(library, Boolean(getActiveTabId()));
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
		// texCompiling panes are owned by the compile flow (openTexPdf fills
		// them itself); hydrating here would race the compile and swap the
		// shimmer for a cannotPreview error within milliseconds.
		if (!tab || tab.loaded || tab.texCompiling || placeholderLoads.has(id)) {
			continue;
		}
		// Paper ownership needs the tree: dotted folder names (e.g. arXiv IDs)
		// otherwise look like files and resolve to their parent org folder.
		if (vaultStore.getState().treeLoading && isUnderPapers(tab.path)) continue;
		placeholderLoads.add(id);
		void (async () => {
			const vaultState = vaultStore.getState();
			const generation = vaultLoadGeneration();
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
					vaultStore.getState().vaultPath !== vaultState.vaultPath ||
					vaultLoadGeneration() !== generation
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
				const patch = patchFromTabResources(res, current);
				updateTab(id, patch);
				// A restored paper body hydrates after its NOTES panel was
				// pruned from the layout — open the companion now, otherwise
				// the first click shows the PDF without notes beside it.
				if (
					res.kind === "paper" &&
					(patch.mode === "pdf" || patch.mode === "html") &&
					res.notesPath &&
					loadSettings().autoOpenPaperNotes
				) {
					openNotesForPaper(id, patch, tab.path);
				}
			} finally {
				placeholderLoads.delete(id);
			}
		})();
	}
}

/**
 * After the vault tree finishes loading, some restored paper tabs may have been
 * misclassified as Library because `paperFolders` was still empty during the
 * first hydration. Reset those tabs to placeholders and hydrate them again.
 */
export function rehydrateMisclassifiedPaperTabs(): void {
	if (!isTauri() || !getVaultPath()) return;
	const { paperFolders } = vaultStore.getState();
	if (!paperFolders.length) return;

	const ids: string[] = [];
	for (const tab of getTabs()) {
		if (!tab.loaded || tab.kind !== "library") continue;
		if (
			isLibraryVirtualPath(tab.path) ||
			isTrashVirtualPath(tab.path) ||
			isPlazaVirtualPath(tab.path)
		) {
			continue;
		}
		if (!isUnderPapers(tab.path)) continue;
		if (paperDirFromPath(tab.path, paperFolders)) {
			ids.push(tab.id);
		}
	}
	if (!ids.length) return;

	for (const id of ids) placeholderLoads.delete(id);
	for (const id of ids) updateTab(id, { loaded: false });
	hydratePlaceholderTabs(ids);
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

/**
 * Open the Zen workspace: collapse the Agent rail (Zen takes over its current
 * conversation on first open) and focus the virtual Zen tab.
 * Reached by clicking the tree's Agent root row.
 */
export function openZenWorkspace(): void {
	layout()?.setRightCollapsed(true);
	seedZenFromRail(getVaultPath());
	openTab(ZEN_VIRTUAL_PATH);
}

/** Open one Plaza source panel (from its tree child row). */
export function openPlazaSource(source: PlazaSource): void {
	if (!loadSettings().plazaEnabled) return;
	setTreeSelectedPath(source.path);
	openTab(source.path);
}

/**
 * Org folder click: `papers/` folders focus the same Library tab filtered by
 * path prefix. Other folders (`notes/`, `.agents/`, `plans`, …) only keep the
 * tree selection so clicking them never steals the active view.
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
	const scope = resolveLibraryScopePath(rel || null);
	if (!scope) return;
	setLibraryScopePath(scope);
	// Reuse / focus the single full-library tab only.
	openTab(LIBRARY_VIRTUAL_PATH);
}

/**
 * Pure-rule decision for a file-tree click. Registered locally (see
 * `@/lib/decision/registry`) because the whole judgement depends on frontend
 * state and needs no AI round-trip.
 */
registerDecision<{ node: FileNode }>({
	id: "file-tree.click",
	description: "Decide what to do when a file-tree node is clicked",
	defaultAction: "noop",
	rules: [
		({ node }) => (isLibraryVirtualPath(node.path) ? "select-library" : null),
		({ node }) => (isTrashVirtualPath(node.path) ? "select-trash" : null),
		({ node }) => (isPlazaVirtualPath(node.path) ? "select-plaza" : null),
		({ node }) =>
			node.kind === "directory" && isPaperDirectory(node.path, node.children)
				? "open-paper"
				: null,
		({ node }) =>
			node.kind === "directory" &&
			isVaultSkillDirectory(getVaultPath(), node.path)
				? "open-skill"
				: null,
		({ node }) => (node.kind === "directory" ? "scope-library" : null),
		({ node }) => (node.kind === "file" ? "open-path" : null),
	],
});

/** File-tree click dispatch: Library / Trash / Plaza / paper dir / org dir / file. */
const recentWritingFiles = new Map<string, string>();
let writingSelectionRequest = 0;
/** Latest source swap request per writing panel; stale loads are dropped. */
const writingSourceSwaps = new Map<string, number>();

export function rememberWritingSource(path: string, root: string): void {
	if (/\.tex$/i.test(path)) recentWritingFiles.set(root, path);
}

/** Last source shown by a writing project, matched case-insensitively. */
function recentWritingSource(root: string): string | null {
	const key = normalizeTabPath(root);
	for (const [project, source] of recentWritingFiles) {
		if (normalizeTabPath(project) === key) return source;
	}
	return null;
}

/**
 * The one dock panel that owns a writing project. A legacy session can still
 * hold several tabs for one root (each was opened as its own source): prefer
 * the active one, then the tab showing the project's recent source.
 */
export function writingPanelForRoot(
	tabs: readonly DocTab[],
	root: string,
): DocTab | null {
	const key = normalizeTabPath(root);
	const candidates = tabs.filter(
		(tab) =>
			tab.writingRoot &&
			normalizeTabPath(tab.writingRoot) === key &&
			isCanonicalView(tab),
	);
	if (!candidates.length) return null;
	const activeId = getActiveTabId();
	const active = candidates.find((tab) => tab.id === activeId);
	if (active) return active;
	const recent = recentWritingSource(root);
	if (recent) {
		const recentKey = normalizeTabPath(recent);
		const matching = candidates.find(
			(tab) => normalizeTabPath(tab.path) === recentKey,
		);
		if (matching) return matching;
	}
	return candidates[0] ?? null;
}

/**
 * Open a source file of a writing project.
 *
 * The project owns one dock panel: an existing project panel swaps its left
 * source pane in place (the embedded compiled PDF, its page/zoom/scroll and
 * the source/PDF split stay untouched), a target already open in another tab
 * is focused, and a different project opens/activates its own panel.
 *
 * `restoreSource` is the compiled-PDF entry: it shows the project's recent
 * source instead of the PDF itself.
 */
export function openWritingSource(
	path: string,
	root: string,
	restoreSource = false,
): void {
	const target = restoreSource ? (recentWritingSource(root) ?? root) : path;
	const existing = findCanonicalTab(getTabs(), target);
	if (existing) {
		// Existing dedupe: never open the same file twice. Give a tab that
		// predates project identity its owner so later opens find it.
		if (
			!existing.writingRoot ||
			normalizeTabPath(existing.writingRoot) !== normalizeTabPath(root)
		) {
			updateTab(existing.id, { writingRoot: root });
		}
		rememberWritingSource(target, root);
		setTreeSelectedPath(target);
		cacheActiveTabBeforeDock(existing.id);
		dockHandle()?.activatePanel(existing.id);
		return;
	}
	const panel = writingPanelForRoot(getTabs(), root);
	if (panel) {
		swapWritingSource(panel, target, root);
		return;
	}
	rememberWritingSource(target, root);
	setTreeSelectedPath(target);
	openTab(target);
	const opened = findCanonicalTab(getTabs(), target);
	if (opened) updateTab(opened.id, { writingRoot: root });
}

/**
 * Replace one writing panel's source pane with `target`, keeping the dockview
 * panel id and `writingRoot` (so `ProjectPdf` keyed by the root does not reload
 * and the split ratio survives). The outgoing editor flushes first, then
 * `textEpoch` remounts the source viewer on the new file.
 */
function swapWritingSource(panel: DocTab, target: string, root: string): void {
	const token = (writingSourceSwaps.get(panel.id) ?? 0) + 1;
	writingSourceSwaps.set(panel.id, token);
	cacheActiveTabBeforeDock(panel.id);
	dockHandle()?.activatePanel(panel.id);
	if (normalizeTabPath(panel.path) === normalizeTabPath(target)) {
		rememberWritingSource(target, root);
		setTreeSelectedPath(target);
		return;
	}
	void (async () => {
		const vaultState = vaultStore.getState();
		const generation = vaultLoadGeneration();
		const res = await loadTabResources(
			target,
			vaultState.vaultPath,
			vaultState.tree,
			vaultState.paperFolders,
		);
		if (
			writingSourceSwaps.get(panel.id) !== token ||
			vaultLoadGeneration() !== generation ||
			vaultStore.getState().vaultPath !== vaultState.vaultPath
		) {
			return;
		}
		const current = getTabs().find((tab) => tab.id === panel.id);
		if (!current || current.path !== panel.path) return;
		if (res.error) {
			notifyError(
				res.error === "cannotPreview"
					? i18n.t("app:errors.cannotPreview", { name: basenameOf(target) })
					: res.error,
			);
			return;
		}
		// The outgoing editor must not lose its debounced autosave to the
		// remount below. A refused save (disk conflict) keeps the panel as-is.
		const markdown = markdownEditorFor(panel.id);
		if (markdown?.hasPendingSource() && !(await markdown.flushSource())) {
			return;
		}
		if (!(await flushTextEditorFor(panel.path))) return;
		const latest = getTabs().find((tab) => tab.id === panel.id);
		if (!latest || latest.path !== panel.path) return;
		// The outgoing source pane may currently show a project asset (image /
		// material PDF) holding a viewer source lease; replace releases it.
		revokeTabMediaSources(latest);
		updateTab(panel.id, {
			...patchFromTabResources(res, latest),
			path: target,
			title: tabTitleForPath(target),
			writingRoot: root,
			// Remount the source viewer on the new file. The dockview panel (and
			// the compiled-PDF pane inside it) stays mounted.
			textEpoch: latest.textEpoch + 1,
			markdownDirty: false,
			notesDirty: false,
			textDirty: false,
		});
		rememberWritingSource(target, root);
		setTreeSelectedPath(target);
	})();
}

/**
 * Resolve `path` to its writing project and open it through
 * {@link openWritingSource}. Falls back to a plain document tab when the path
 * is not part of a resolvable project (e.g. an unconfigured folder).
 */
export async function openWritingSourceAt(path: string): Promise<void> {
	const vault = getVaultPath();
	if (!vault || !isWritingPath(vault, path)) {
		openPath(path);
		return;
	}
	let project: Awaited<ReturnType<typeof resolveWritingTarget>>;
	try {
		project = await resolveWritingTarget(vault, path);
	} catch (error) {
		notifyError(errorText(error));
		return;
	}
	if (vault !== getVaultPath()) return;
	if (!project) {
		openPath(path);
		return;
	}
	openWritingSource(path, project.root, project.compiledPdf);
}

/** File-tree / project-row entry: open a project source, or restore it from PDF. */
export function openWritingFile(
	path: string,
	root: string,
	restoreSource = false,
): void {
	openWritingSource(path, root, restoreSource);
}

export function selectFileNode(node: FileNode): void {
	const request = ++writingSelectionRequest;
	const vault = getVaultPath();
	// The Agent root row is the Zen entry: the label opens the workspace, the
	// disclosure chevron still expands AGENTS.md / skills as before.
	if (vault && isVaultAgentRoot(vault, node.path)) {
		setTreeSelectedPath(node.path);
		openZenWorkspace();
		return;
	}
	if (
		vault &&
		normalizeTabPath(node.path) ===
			normalizeTabPath(joinVaultPath(vault, "thesis"))
	) {
		setTreeSelectedPath(node.path);
		return;
	}
	if (vault && isWritingPath(vault, node.path)) {
		setTreeSelectedPath(node.path);
		void resolveWritingTarget(vault, node.path, node.kind === "directory")
			.then((project) => {
				if (request !== writingSelectionRequest || vault !== getVaultPath())
					return;
				if (project)
					openWritingFile(
						node.path,
						project.root,
						node.kind === "directory" || project.compiledPdf,
					);
				else selectFileNodeNormally(node);
			})
			.catch((error) => {
				if (request === writingSelectionRequest) notifyError(errorText(error));
			});
		return;
	}
	selectFileNodeNormally(node);
}

function selectFileNodeNormally(node: FileNode): void {
	switch (decideSync<{ node: FileNode }>("file-tree.click", { node })) {
		case "select-library":
			selectLibrary();
			return;
		case "select-trash":
			selectTrash();
			return;
		case "select-plaza": {
			if (!loadSettings().plazaEnabled) return;
			// The Plaza root is a plain folder; only source children open a tab.
			const source = plazaSourceForPath(node.path);
			if (source) openPlazaSource(source);
			return;
		}
		case "open-paper":
			openPaper(node.path);
			return;
		case "open-skill":
			openPath(skillMarkdownPath(node) ?? joinVaultPath(node.path, "SKILL.md"));
			return;
		case "scope-library": {
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
		case "open-path":
			openPath(node.path);
			return;
		default:
			return;
	}
}

/**
 * Synchronize open workspace tabs when a paper has been recognized and renamed.
 * Reloads the paper's metadata, canonical PDF path, and updated NOTES.md content,
 * bumping editor reload keys and updating dockview panel titles.
 */
export async function syncRenamedPaperTabs(
	vaultId: string,
	toAbs: string,
): Promise<void> {
	const vaultState = vaultStore.getState();
	const generation = vaultLoadGeneration();
	let res: Awaited<ReturnType<typeof loadTabResources>>;
	try {
		res = await loadTabResources(
			toAbs,
			vaultId,
			vaultState.tree,
			vaultState.paperFolders,
		);
	} catch {
		return;
	}
	if (vaultLoadGeneration() !== generation) return;

	const notesPath = res.notesPath ?? notesPathForPaper(toAbs);
	const paperKey = normalizeTabPath(toAbs);
	const notesKey = normalizeTabPath(notesPath);
	const currentTabs = getTabs();

	for (const tab of currentTabs) {
		const tabPath = tab.path ? normalizeTabPath(tab.path) : "";
		if (tabPath === paperKey) {
			updateTab(tab.id, {
				title: res.title || tab.title,
				paperMeta: res.paperMeta ?? tab.paperMeta,
				pdfUrl: res.pdfUrl ?? tab.pdfUrl,
				pdfBytes: res.pdfBytes ?? tab.pdfBytes,
				notesPath,
				notesSeed: res.notesSeed,
				notesKey: tab.notesKey + 1,
			});
		} else if (
			(tab.notesPath && normalizeTabPath(tab.notesPath) === notesKey) ||
			tabPath === notesKey
		) {
			updateTab(tab.id, {
				notesSeed: res.notesSeed,
				markdownSeed: res.notesSeed,
				notesKey: tab.notesKey + 1,
				seedKey: tab.seedKey + 1,
				paperMeta: res.paperMeta ?? tab.paperMeta,
				notesPath,
				path: notesPath,
			});
		}
	}

	if (notesPath) {
		void applyDiskChange(notesPath);
	}
}

/**
 * Synchronize open workspace tabs when a paper's metadata has been edited or refreshed.
 * Updates the tab's `title` (for paper tabs) and `paperMeta`, and notifies open NOTES.md
 * of possible title sync on disk.
 */
export function syncUpdatedPaperTabs(
	vaultPath: string,
	relPath: string,
	updated: PaperMetadata,
	fallbackId?: string,
): void {
	const normRel = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const paperAbs = joinVaultPath(vaultPath, normRel);
	const notesAbs = joinVaultPath(vaultPath, `${normRel}/NOTES.md`);
	const normNotesRel = `${normRel}/notes.md`.toLowerCase();

	setTabs((prev) =>
		prev.map((tab) => {
			const tabRel = toVaultRelative(vaultPath, tab.path)
				.replace(/\\/g, "/")
				.replace(/^\/+|\/+$/g, "");
			const metaRel = tab.paperMeta?.path
				?.replace(/\\/g, "/")
				.replace(/^\/+|\/+$/g, "");

			const isDirectPaperTab =
				tabRel === normRel || metaRel === normRel || tab.path === paperAbs;

			const isSamePaperId = Boolean(
				fallbackId && tab.paperMeta?.id && tab.paperMeta.id === fallbackId,
			);

			const isNotesTab =
				Boolean(tab.notesPath && tab.notesPath === notesAbs) ||
				Boolean(tabRel && tabRel.toLowerCase() === normNotesRel);

			if (!isDirectPaperTab && !isSamePaperId && !isNotesTab) {
				return tab;
			}

			const nextTitle =
				tab.kind === "paper"
					? updated.title?.trim() || basenameOf(tab.path)
					: tab.title;

			return {
				...tab,
				title: nextTitle,
				// A full catalog record omits cleared optional fields.
				paperMeta: updated,
			};
		}),
	);

	void applyDiskChange(notesAbs);
}
