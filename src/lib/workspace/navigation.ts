/**
 * Tab open/close, paper+NOTES pairing, and library / file-tree selection.
 */

import i18n from "@/i18n";
import { notePaperFocus, track } from "@/lib/activity";
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
import { setLayoutMode } from "@/lib/shell/ui-store";
import { type FileNode, joinVaultPath } from "@/lib/vault";
import {
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
import { dockHandle } from "@/lib/workspace/dock-registry";
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
	findNotesPaneForReplacement,
	insertPlaceholderTab,
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
	SPLIT_PANE_ID_MARKER,
	splitPaneIdForPath,
	tabHasNotesSplit,
	tabIdForPath,
	tabIsPaperNotes,
	tabNotesEligible,
} from "./tabs";
import { type CenterViewMode, preferredModeForPath } from "./viewer";

/**
 * Library is resident: with a Vault open its tab must always exist in the
 * strip. Active focus is left to dockview (`onDidActivePanelChange` / sync end).
 */
function withLibraryPresent(next: DocTab[]): DocTab[] {
	if (!getVaultPath()) return next;
	return ensureFullLibraryTab(next).tabs;
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
		/**
		 * Replace this notes panel in place instead of adding another tab.
		 * Used when the reading layout already shows a notes column and the
		 * user opens another note.
		 */
		replaceNotesPaneId?: string | null;
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
			const wantDefaultNotes =
				!opts?.skipDefaultNotes &&
				!opts?.placement &&
				Boolean(existing.notesPath) &&
				(opts?.forceNotes || loadSettings().autoOpenPaperNotes);
			if (wantDefaultNotes && !tabHasNotesSplit(getTabs(), existing)) {
				openTabNotes(existing.id);
			}
			activatePaperWithNotes(existing);
		} else {
			setActiveTabId(id);
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
	setActiveTabId(insertedId);
	if (replaced) {
		dockHandle()?.remapPanel(replaced.id, placeholder);
		dockHandle()?.activatePanel(insertedId);
	} else {
		dockHandle()?.openPanel(placeholder, initialPlacement);
	}

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
		// Guard against a transient PDF-probe miss with the placeholder's
		// preferMode (⇧⌘T reopen of a closed PDF tab), not `existing` — an
		// existing tab returned early above and is never patched here.
		const patch = patchFromTabResources(res, placeholder);
		updateTab(id, patch);

		// Paper default: NOTES in the notes column (or first-time right split).
		const wantDefaultNotes =
			!opts?.skipDefaultNotes &&
			!opts?.placement &&
			res.kind === "paper" &&
			Boolean(res.notesPath) &&
			(patch.mode === "pdf" || patch.mode === "html") &&
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
		columns: readingColumns(),
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
	// Library is resident — never closable (its close affordance is hidden).
	const target = getTabs().find((t) => t.id === id);
	if (target && isLibraryVirtualPath(target.path)) return;
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
		return withLibraryPresent(next);
	});
	for (const closeId of idsToClose) cancelPdfNavigationForTab(closeId);
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
		return withLibraryPresent(tabs);
	});
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
		if (previous && remapped && previous.id !== remapped.id) {
			dockHandle()?.remapPanel(previous.id, remapped);
		}
	}
	const active = previousTabs.find((tab) => tab.id === getActiveTabId());
	if (active) {
		setActiveTabId(tabIdForPath(remapPathUnder(active.path, fromAbs, toAbs)));
	}
	remapTabAnnotations(
		previousTabs.map((tab) => ({
			fromId: tab.id,
			toId: tabIdForPath(remapPathUnder(tab.path, fromAbs, toAbs)),
		})),
	);
	setTabs(remappedTabs);
	setTreeSelectedPath((path) =>
		path ? remapPathUnder(path, fromAbs, toAbs) : path,
	);
	setLibraryScopePath((scope) =>
		scope ? remapPathUnder(scope, fromRel, toRel) : scope,
	);
}

/** Close every panel whose path is at or under the given path. */
export function closeTabsUnderPath(path: string): void {
	let removedIds: string[] = [];
	setTabs((prev) => {
		const { tabs, removed } = removeTabsUnderPath(prev, path);
		if (!removed.length) return prev;
		for (const t of removed) revokeTabMediaSources(t);
		removedIds = removed.map((t) => t.id);
		return withLibraryPresent(tabs);
	});
	for (const removedId of removedIds) cancelPdfNavigationForTab(removedId);
	if (removedIds.length) removeTabAnnotations(removedIds);
}

/** Cycle the active panel by dockview visual order (api.panels). */
export function cycleActiveTab(delta: number): void {
	dockHandle()?.cycleActive(delta);
}

export function cloneTabForSplit(tab: DocTab, tabs: DocTab[]): DocTab {
	return {
		...tab,
		id: splitPaneIdForPath(
			tab.path,
			tabs.map((candidate) => candidate.id),
		),
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
	const notesId = tabIdForPath(target.notesPath);
	const isOpen = tabHasNotesSplit(getTabs(), target);
	if (isOpen === open) return;
	if (!open) {
		dockHandle()?.rememberNotesSplitWidth(target.id, notesId);
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
		columns: readingColumns(),
	});
	setTabs((prev) => {
		if (prev.some((t) => t.id === notesPane.id)) return prev;
		return [...prev, notesPane];
	});
	dockHandle()?.openPanel(notesPane, notesPlacement);
	if (notesPlacement?.direction === "right") {
		dockHandle()?.restoreNotesSplitWidth(target.id, notesPane.id);
	}
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
		columns: readingColumns(),
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
			!getTabs().some((t) => t.id === tabIdForPath(abs))
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
	if (!getActiveTabId()) setActiveTabId(ensured.activeId);
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
export function rememberWritingSource(path: string, root: string): void {
	if (/\.tex$/i.test(path)) recentWritingFiles.set(root, path);
}

export function openWritingFile(
	path: string,
	root: string,
	restoreSource = false,
): void {
	const target = restoreSource ? (recentWritingFiles.get(root) ?? root) : path;
	rememberWritingSource(target, root);
	openTab(target);
	updateTab(tabIdForPath(target), { writingRoot: root });
}

export function selectFileNode(node: FileNode): void {
	const request = ++writingSelectionRequest;
	const vault = getVaultPath();
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

	const paperTabId = tabIdForPath(toAbs);
	const notesPath = res.notesPath ?? notesPathForPaper(toAbs);
	const notesTabId = tabIdForPath(notesPath);
	const currentTabs = getTabs();
	// Split panes share a path but carry a `::pane-N` suffix on their id.
	const isPaneOf = (id: string, baseId: string) =>
		id === baseId || id.startsWith(`${baseId}${SPLIT_PANE_ID_MARKER}`);

	for (const tab of currentTabs) {
		if (isPaneOf(tab.id, paperTabId) || tab.path === toAbs) {
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
			isPaneOf(tab.id, notesTabId) ||
			(tab.notesPath &&
				normalizeTabPath(tab.notesPath) === normalizeTabPath(notesPath)) ||
			(tab.path && normalizeTabPath(tab.path) === normalizeTabPath(notesPath))
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
