/**
 * Workspace actions: open/close/cycle document panels, paper+NOTES pairing,
 * Markdown persistence, disk-change reseeding, and wiki navigation. Plain
 * functions over the vanilla stores (`getState()` replaces the old App ref
 * mirrors); dockview is driven through the registered dock handle.
 */

import i18n from "@/i18n";
import { notePaperFocus, track } from "@/lib/activity";
import type { CitationTarget } from "@/lib/agent/api";
import { resolvePdfCitation } from "@/lib/agent/api";
import {
	citationHrefFromWikiParts,
	cleanCitationHref,
	isAgentCitationHref,
	rewriteCitationHrefToPdf,
} from "@/lib/agent/citation-href";
import { errorText } from "@/lib/core/error";
import { notifyError, notifyUndo, notifyWarning } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { closeTopOverlay } from "@/lib/core/overlay-stack";
import { isTauri } from "@/lib/core/tauri";
import { lifecycle } from "@/lib/lifecycle";
import {
	detectPaperDirectory,
	isPaperDirectory,
	isRemoteArxivPath,
	isUnderPaperAttachments,
	isUnderPapers,
	localFileToArrayBuffer,
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
	lookupAnnotationRef,
	paperAbsFromWikiTarget,
} from "@/lib/pdf/annotation-ref";
import { removeTabAnnotations } from "@/lib/pdf/annotations-store";
import { stripEmbedPdfRevision } from "@/lib/pdf/document-id";
import {
	buildLayoutDocumentResult,
	getLayoutDocumentResult,
	layoutKindFromCitationFragment,
	mergeCaptionsIntoHosts,
	setLayoutDocumentResult,
} from "@/lib/pdf/layout";
import { readLayoutSidecar } from "@/lib/pdf/layout/io";
import {
	clearPendingPdfPage,
	setPendingPdfPage,
} from "@/lib/pdf/pending-pdf-page";
import { registerScrollSyncPair } from "@/lib/pdf/scroll-sync";
import {
	isPlazaVirtualPath,
	type PlazaSource,
	plazaSourceForPath,
} from "@/lib/plaza";
import { loadSettings } from "@/lib/settings";
import { closeCurrentWindow } from "@/lib/shell/close-window";
import { setLayoutMode } from "@/lib/shell/ui-store";
import {
	ensureLocalFsScope,
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
	refreshTabExcalidraw,
	refreshTabMarkdown,
	refreshTabNotes,
	refreshTabPdf,
	refreshTabText,
	setActiveTabId,
	setTabs,
	takeClosedTab,
	updateTab,
} from "@/lib/workspace/store";
import { flushAllTextEditors } from "@/lib/workspace/text-editor-flush";
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
	patchFromTabResources,
	patchTab,
	readingPairCloseIds,
	removeTab,
	removeTabsUnderPath,
	reseedExcalidrawTab,
	reseedTextTab,
	revokeTabMediaSources,
	SPLIT_PANE_ID_MARKER,
	splitPaneIdForPath,
	syncTabSeedsForPath,
	tabHasNotesSplit,
	tabIdForPath,
	tabIsPaperNotes,
	tabNotesEligible,
	translationSplitPlacement,
} from "./tabs";
import {
	compileTexFile,
	ensureTexEngines,
	resolveTexRoot,
	texCompileStore,
} from "./tex-compile";
import {
	type CenterViewMode,
	isTexPath,
	preferredModeForPath,
	texPdfPath,
} from "./viewer";

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

/**
 * Open (or refresh) the compiled PDF of a .tex file as a right split of its
 * editor pane — the TeX analogue of the paper→NOTES right split. The PDF is
 * the project ROOT's output (magic comment → self indicator → vault
 * \input/\include reverse scan → the file itself), so triggering this from a
 * child file still builds and shows the root's PDF. When the PDF is missing
 * on disk (or `forceCompile`, the compile-button path), the pane opens
 * immediately with a shimmer placeholder while the compile runs, then fills
 * in. Existing PDF tabs are refreshed in place (new bytes identity reloads
 * EmbedPDF) and activated.
 */
export async function openTexPdf(
	texPath: string,
	opts?: { referencePanelId?: string | null; forceCompile?: boolean },
): Promise<void> {
	if (!isTexPath(texPath)) return;
	// One in-flight compile at a time (mirrors compileTexFile's guard).
	if (texCompileStore.getState().compilingPath) return;

	// Locate the reference editor panel (handles ::pane-N clones); open the
	// editor first when it is not on screen so the PDF lands beside it.
	const canonicalTexId = tabIdForPath(texPath);
	const refId =
		opts?.referencePanelId ??
		getTabs().find(
			(t) =>
				t.id === canonicalTexId ||
				t.id.startsWith(`${canonicalTexId}${SPLIT_PANE_ID_MARKER}`),
		)?.id ??
		null;
	if (!refId) {
		// openTab creates the dockview panel synchronously, so the id below
		// resolves immediately.
		openTab(texPath, { preferMode: "text" });
	}
	const referencePanelId = refId ?? canonicalTexId;

	// Flush every mounted editor's debounced autosave first (a root compile
	// must read the latest bytes of all its sections — the saveAll
	// equivalent), then resolve the root from that fresh disk state so a
	// just-typed magic comment or \input already counts. Both before the
	// fast path: the pane id must follow the root either way.
	await flushAllTextEditors();
	const rootPath = await resolveTexRoot(texPath);
	const pdfPath = texPdfPath(rootPath);
	const pdfId = tabIdForPath(pdfPath);
	await ensureLocalFsScope(vaultStore.getState().vaultPath);

	if (!opts?.forceCompile) {
		// Fast path: the PDF is already on disk → open/refresh, no shimmer.
		const bytes = await localFileToArrayBuffer(pdfPath);
		if (bytes) {
			if (getTabs().some((t) => t.id === pdfId)) {
				updateTab(pdfId, {
					pdfBytes: bytes,
					loaded: true,
					texCompiling: false,
					title: basenameOf(pdfPath),
				});
				setActiveTabId(pdfId);
				dockHandle()?.activatePanel(pdfId);
			} else {
				openTab(pdfPath, {
					preferMode: "pdf",
					placement: { direction: "right", referencePanelId },
				});
			}
			return;
		}
	}

	// Show the PDF pane immediately as a shimmer placeholder, then fill it
	// once the compile lands.
	const paneAlreadyOpen = getTabs().some((t) => t.id === pdfId);
	if (paneAlreadyOpen) {
		updateTab(pdfId, { texCompiling: true });
		setActiveTabId(pdfId);
		dockHandle()?.activatePanel(pdfId);
	} else {
		// Hand-rolled openTab prefix (placeholder + dock placement) without
		// the async resource load — the PDF does not exist yet, so
		// loadTabResources would only surface a cannotPreview error.
		const beforeTabs = getTabs();
		const { tabs: nextTabs, id: insertedId } = insertPlaceholderTab(
			beforeTabs,
			pdfPath,
			"pdf",
		);
		const placeholder =
			nextTabs.find((t) => t.id === insertedId) ??
			createPlaceholderTab(pdfPath, "pdf");
		setTabs(nextTabs);
		setActiveTabId(insertedId);
		dockHandle()?.openPanel(placeholder, {
			direction: "right",
			referencePanelId,
		});
		updateTab(insertedId, { texCompiling: true });
	}

	const compiled = await compileTexFile(rootPath, { triggerPath: texPath });
	const bytes = compiled ? await localFileToArrayBuffer(compiled) : null;
	if (!compiled || !bytes) {
		// Failure already notified. Drop a pane we just created (it would sit
		// on a shimmer forever); just un-flag a pre-existing one so it shows
		// its previous content again.
		if (paneAlreadyOpen) updateTab(pdfId, { texCompiling: false });
		else closeTab(pdfId, { remember: false });
		if (compiled) {
			// The compile itself succeeded but its output could not be read
			// back (fs scope / file vanished). Say so — a silent revert behind
			// the success toast reads as "the PDF did not update".
			notifyError(
				i18n.t("app:errors.pdfReadFailed", { name: basenameOf(pdfPath) }),
			);
		}
		return;
	}
	updateTab(pdfId, {
		pdfBytes: bytes,
		loaded: true,
		texCompiling: false,
		title: basenameOf(pdfPath),
	});
}

/** Latest .tex save that landed while a compile was already running; one
 * trailing recompile keeps the PDF fresh without per-save compile storms. */
let pendingSaveCompilePath: string | null = null;

/**
 * Quiet TeX compile + in-place refresh of the open PDF pane: the compile-button
 * flow without the focus steal, pane auto-open and success toast. Called after
 * a manual ⌘S save lands (`compileTexOnManualSave`). The build target is the
 * project ROOT (saving a child recompiles the root and refreshes the root's
 * PDF pane), resolved after flushing every mounted editor — ⌘S only guaranteed
 * the triggered file on disk. The pane's shimmer (`texCompiling`) stays up
 * while latexmk runs so partial watcher writes never flash through; triggers
 * landing mid-compile queue a single trailing run with the latest path
 * (re-resolving the root against the then-current disk state).
 */
export async function compileTexOnSave(texPath: string): Promise<void> {
	// Right after a window reload the detection scan may still be in flight:
	// wait for it instead of silently dropping this trigger.
	await ensureTexEngines();
	const { engines, selectedEngine, compilingPath } = texCompileStore.getState();
	// No engine available: explicit triggers surface this via
	// `compileTexOnManualSave`; programmatic callers stay silent.
	if (!selectedEngine && engines.length === 0) return;
	if (compilingPath) {
		pendingSaveCompilePath = texPath;
		return;
	}
	await flushAllTextEditors();
	const rootPath = await resolveTexRoot(texPath);
	const pdfPath = texPdfPath(rootPath);
	const pdfId = tabIdForPath(pdfPath);
	const paneOpen = getTabs().some((t) => t.id === pdfId);
	if (paneOpen) updateTab(pdfId, { texCompiling: true });
	try {
		const compiled = await compileTexFile(rootPath, {
			quietSuccess: true,
			triggerPath: texPath,
		});
		const bytes = compiled ? await localFileToArrayBuffer(compiled) : null;
		if (!compiled || !bytes) {
			// Drop the shimmer on the previous content; the failure itself was
			// notified by compileTexFile.
			if (paneOpen) updateTab(pdfId, { texCompiling: false });
			if (compiled) {
				notifyError(
					i18n.t("app:errors.pdfReadFailed", { name: basenameOf(pdfPath) }),
				);
			}
			return;
		}
		updateTab(pdfId, {
			pdfBytes: bytes,
			loaded: true,
			texCompiling: false,
			title: basenameOf(pdfPath),
		});
	} finally {
		if (pendingSaveCompilePath) {
			const next = pendingSaveCompilePath;
			pendingSaveCompilePath = null;
			void compileTexOnSave(next);
		}
	}
}

/**
 * ⌘S manual-save trigger for text tabs: compile the .tex once its save landed
 * (the editor flushes before calling this). Unlike the quiet path this
 * surfaces a missing engine — the user explicitly asked to build. Non-TeX
 * paths are a no-op (⌘S on them just saved).
 */
export async function compileTexOnManualSave(path: string): Promise<void> {
	if (!isTexPath(path)) return;
	await ensureTexEngines();
	const { engines, selectedEngine } = texCompileStore.getState();
	if (!selectedEngine && engines.length === 0) {
		notifyError(i18n.t("sidebar:fileTree.selectEngineFirst"));
		return;
	}
	await compileTexOnSave(path);
}

/** Obsidian-style Split pane: add a right pane and keep columns evenly sized. */
export function splitActivePane(): void {
	const id = getActiveTabId();
	if (!id) return;
	const tabs = getTabs();
	const active = tabs.find((t) => t.id === id);
	if (!active) return;
	// Library is the resident singleton — never clone it into a second pane.
	if (isLibraryVirtualPath(active.path)) return;

	// TeX editor ⌘\ → open/refresh its compiled PDF as the right split.
	if (isTexPath(active.path)) {
		void openTexPdf(active.path, { referencePanelId: active.id });
		return;
	}

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
	// The caller passes the viewer's document id; bytes-backed viewers suffix a
	// per-buffer revision (`tab::r<n>`), so fall back to the stripped form.
	const paperTab =
		tabs.find((t) => t.id === paperTabId) ??
		tabs.find((t) => t.id === stripEmbedPdfRevision(paperTabId));
	if (!paperTab) return;
	paperTabId = paperTab.id;

	const existing = tabs.find(
		(t) => t.id === `${tabIdForPath(paperAbsPath)}::translation`,
	);
	if (existing) {
		// Restored/reused translation tabs do not pass through the creation path;
		// re-bind the two PDF documents every time the source opens translation.
		registerScrollSyncPair(paperTabId, existing.id);
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
	const notesPath = paperTab.notesPath;
	const notesPane = notesPath
		? tabs.find((tab) => tab.id === tabIdForPath(notesPath))
		: null;
	if (notesPane) {
		dockHandle()?.openPanel(translationPane, {
			direction: "within",
			referencePanelId: notesPane.id,
		});
	} else {
		dockHandle()?.splitPanelRight(
			translationPane,
			translationSplitPlacement(paperTabId, tabs).referencePanelId,
		);
	}
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
	openTab(absoluteOrDemoPath, {
		preferMode: preferredModeForPath(absoluteOrDemoPath),
	});
}

/**
 * If `href` carries a PDF citation fragment (`#page=` / `#section=` / …),
 * open via the shared citation jumper. Returns true when handled.
 */
export function tryOpenCitationHref(href: string): boolean {
	const trimmed = cleanCitationHref(href);
	if (!trimmed) return false;
	const rewritten = rewriteCitationHrefToPdf(trimmed);
	if (!isAgentCitationHref(trimmed) && !isAgentCitationHref(rewritten)) {
		return false;
	}
	openCitation(trimmed);
	return true;
}

/** Open a vault-relative path from backlinks (e.g. `notes/idea.md`). */
export function openVaultRel(rel: string): void {
	if (tryOpenCitationHref(rel)) return;
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
	if (tryOpenCitationHref(rel)) return;
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

/** Paper-key aliases so pending-page intent matches `usePdfNavigation`'s paperKey. */
function citationPaperKeys(paperAbs: string): string[] {
	const keys = [paperAbs];
	const vaultPath = getVaultPath();
	if (vaultPath) {
		const rel = toVaultRelative(vaultPath, paperAbs);
		if (rel && rel !== paperAbs) keys.push(rel);
	}
	return keys;
}

/**
 * Wait for the PDF handle after openPaper, then jump to a layout region.
 *
 * First-open races with reading-position restore and EmbedPDF layout: a single
 * early scroll often lands briefly then snaps back to page 1. Stash a pending
 * page for restore to prefer, and re-apply the jump a few times while the
 * viewport settles.
 */
export function scheduleCitationJump(
	paperAbs: string,
	target: CitationTarget,
): void {
	const tabId = tabIdForPath(paperAbs);
	const keys = citationPaperKeys(paperAbs);
	const page = target.pageIndex + 1;
	setPendingPdfPage(keys, page);

	let unsubscribe: (() => void) | null = null;
	const retryTimeoutIds: number[] = [];
	let stopped = false;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		unsubscribe?.();
		for (const id of retryTimeoutIds) window.clearTimeout(id);
	};

	const kind = layoutKindFromCitationFragment(target.fragment);
	const tryJump = () => {
		if (stopped) return;
		const handle = pdfHandleFor(tabId);
		if (!handle) return;
		handle.scrollToLayoutRegion({
			id: target.regionId,
			pageIndex: target.pageIndex,
			bbox: target.bbox,
			kind,
		});
	};

	tryJump();
	unsubscribe = subscribePdfHandles(tryJump);
	// Re-apply after layout/restore can wipe an early scroll (not a busy loop).
	for (const delayMs of [300, 800]) {
		retryTimeoutIds.push(window.setTimeout(tryJump, delayMs));
	}
	retryTimeoutIds.push(
		window.setTimeout(() => {
			stop();
			// Restore may still be about to run; keep the intent briefly.
			window.setTimeout(() => clearPendingPdfPage(keys), 2000);
		}, 2000),
	);
}

/** Short category toast for a failed citation resolve (e.g. figure / section). */
function citationResolveFailedMessage(source: string): string {
	const hash = source.indexOf("#");
	const frag = hash >= 0 ? source.slice(hash + 1) : "";
	const key = (frag.split("=")[0] ?? "").toLowerCase();
	switch (key) {
		case "figure":
			return i18n.t("agent:citation.figureNotFound", { source });
		case "section":
			return i18n.t("agent:citation.sectionNotFound", { source });
		case "table":
			return i18n.t("agent:citation.tableNotFound", { source });
		case "algorithm":
			return i18n.t("agent:citation.algorithmNotFound", { source });
		case "formula":
			return i18n.t("agent:citation.formulaNotFound", { source });
		case "page":
			return i18n.t("agent:citation.pageNotFound", { source });
		case "region":
			return i18n.t("agent:citation.regionNotFound", { source });
		default:
			return i18n.t("agent:citation.resolveFailed", { source });
	}
}

/**
 * Open a citation link from agent output.
 *
 * Plain vault paths open as documents. Links that point at a paper file and
 * carry a `#section=`, `#figure=`, `#page=`, or `#region=` fragment resolve
 * the fragment on the Host and jump the PDF viewer to the cited location.
 */
export function openCitation(source: string): void {
	const trimmed = rewriteCitationHrefToPdf(cleanCitationHref(source));
	if (!trimmed) return;
	if (/^https?:\/\//i.test(trimmed)) {
		openExternalUrl(trimmed);
		return;
	}

	const fragmentIndex = trimmed.indexOf("#");
	const path = fragmentIndex >= 0 ? trimmed.slice(0, fragmentIndex) : trimmed;
	const fragment = fragmentIndex >= 0 ? trimmed.slice(fragmentIndex + 1) : "";
	if (!fragment) {
		// Prefer opening the paper unit for PDF paths; plain notes still use graph open.
		if (/\.pdf$/i.test(path)) {
			const vaultPath = getVaultPath();
			if (vaultPath) {
				const clean = normalizeVaultRel(path);
				const full = joinVaultPath(vaultPath, clean);
				const paperAbs =
					paperDirFromPath(full, vaultStore.getState().paperFolders) ?? null;
				if (paperAbs) {
					openPaper(paperAbs);
					return;
				}
			}
		}
		openGraphPath(path);
		return;
	}

	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(i18n.t("app:errors.openVaultForGraph"));
		return;
	}

	const clean = normalizeVaultRel(path);
	const full = joinVaultPath(vaultPath, clean);
	const paperAbs =
		paperDirFromPath(full, vaultStore.getState().paperFolders) ?? null;

	if (!paperAbs) {
		// Best-effort: if the path itself is a paper folder, open it.
		void (async () => {
			if (await detectPaperDirectory(full)) {
				openPaper(full);
				void resolvePdfCitation(vaultPath, trimmed)
					.then((target) => scheduleCitationJump(full, target))
					.catch((e) => {
						notifyError(citationResolveFailedMessage(trimmed));
						console.warn("resolve citation failed", e);
					});
				return;
			}
			openGraphPath(path);
		})();
		return;
	}

	openPaper(paperAbs);
	void resolvePdfCitation(vaultPath, trimmed)
		.then((target) => scheduleCitationJump(paperAbs, target))
		.catch((e) => {
			notifyError(citationResolveFailedMessage(trimmed));
			console.warn("resolve citation failed", e);
		});
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
		// PDF / layout citation fragments (page=/section=/figure=/…) share the
		// agent citation jumper so editor wikilinks and markdown links behave alike.
		const citationHref = citationHrefFromWikiParts(
			destination.path,
			destination.fragment,
		);
		if (citationHref && tryOpenCitationHref(citationHref)) {
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
/** Serialize Excalidraw saves per absolute path. */
const excalidrawPersistQueues = new Map<string, Promise<boolean>>();

/** Serialize plain-text editor saves per absolute path. */
const textPersistQueues = new Map<string, Promise<boolean>>();

/**
 * Where disk-change reseeds land. The main window uses the workspace tab
 * store; doc popout windows pass a single-tab sink over local React state.
 */
export type DiskChangeSink = {
	getTabs: () => DocTab[];
	refreshNotes: (paperDir: string, content: string) => void;
	refreshMarkdown: (absPath: string, content: string) => void;
	refreshExcalidraw: (absPath: string, content: string) => void;
	refreshText: (absPath: string, content: string) => void;
	refreshPdf: (absPath: string, bytes: ArrayBuffer) => void;
};

const defaultDiskChangeSink: DiskChangeSink = {
	getTabs,
	refreshNotes: refreshTabNotes,
	refreshMarkdown: refreshTabMarkdown,
	refreshExcalidraw: refreshTabExcalidraw,
	refreshText: refreshTabText,
	refreshPdf: refreshTabPdf,
};

/**
 * Reload an open editor when its file changed on disk (external editor /
 * Agent). Reseeds only when disk content differs from the current seed —
 * equal content means it was our own autosave. The mounted editor reloads the
 * new seed in place (no remount); the path is guarded briefly so a racing
 * autosave cannot overwrite the fresh disk text.
 */
export async function applyDiskChange(
	absPath: string,
	sink: DiskChangeSink = defaultDiskChangeSink,
): Promise<void> {
	const norm = normalizeTabPath(absPath);
	const openTabs = sink.getTabs();
	const notesOwners = openTabs.filter(
		(t) => t.notesPath && normalizeTabPath(t.notesPath) === norm,
	);
	const mdOwners = openTabs.filter(
		(t) => normalizeTabPath(t.path) === norm && isMarkdownPath(t.path),
	);
	const excalidrawOwners = openTabs.filter(
		(t) => normalizeTabPath(t.path) === norm && t.mode === "excalidraw",
	);
	const textOwners = openTabs.filter(
		(t) => normalizeTabPath(t.path) === norm && t.mode === "text",
	);
	const pdfOwners = openTabs.filter(
		(t) =>
			normalizeTabPath(t.path) === norm &&
			(t.mode === "pdf" || t.mode === "translation"),
	);
	if (
		!notesOwners.length &&
		!mdOwners.length &&
		!excalidrawOwners.length &&
		!textOwners.length &&
		!pdfOwners.length
	)
		return;
	// PDF panes reload from bytes: one read feeds every matching pane (source
	// tab + translation split); the fresh ArrayBuffer identity is the mounted
	// viewer's reload signal. Panes still on the compile shimmer are skipped
	// inside refreshPdfTab — the compile flow fills them when the run lands.
	if (pdfOwners.length) {
		const bytes = await localFileToArrayBuffer(absPath);
		if (bytes) sink.refreshPdf(absPath, bytes);
	}
	if (
		!notesOwners.length &&
		!mdOwners.length &&
		!excalidrawOwners.length &&
		!textOwners.length
	)
		return;
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
			sink.refreshNotes(paperDir, content);
		};
		if (notesTab.notesDirty) promptReload(reload);
		else reload();
	}
	for (const mdTab of mdOwners) {
		if (content === mdTab.markdownSeed) continue;
		const reload = () => {
			guard();
			sink.refreshMarkdown(absPath, content);
		};
		if (mdTab.markdownDirty) promptReload(reload);
		else reload();
	}
	for (const excalidrawTab of excalidrawOwners) {
		if (content === excalidrawTab.excalidrawSeed) continue;
		const reload = () => {
			guard();
			sink.refreshExcalidraw(absPath, content);
		};
		if (excalidrawTab.excalidrawDirty) promptReload(reload);
		else reload();
	}
	for (const textTab of textOwners) {
		if (content === textTab.textSeed) continue;
		const reload = () => {
			guard();
			sink.refreshText(absPath, content);
		};
		if (textTab.textDirty) promptReload(reload);
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

/**
 * Persist a specific `.excalidraw` file to disk. The ExcalidrawViewer calls
 * this with its own fixed path (debounced autosave and unmount flush).
 */
export function persistExcalidrawFile(
	path: string,
	json: string,
	lastSaved: string,
): Promise<boolean> {
	if (!isTauri() || !getVaultPath() || !path) return Promise.resolve(false);
	const normalizedPath = normalizeTabPath(path);
	const previous =
		excalidrawPersistQueues.get(normalizedPath) ?? Promise.resolve(false);
	const attempt = previous
		.catch(() => false)
		.then(async () => {
			if (reseedGuard.has(normalizedPath)) return false;
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
				await writeVaultFile(path, json);
				trackSelfWrittenPath(path);
				setTabs((prev) => reseedExcalidrawTab(prev, path, json));
				return true;
			} catch (e) {
				notifyError(errorText(e));
				return false;
			}
		});
	excalidrawPersistQueues.set(normalizedPath, attempt);
	void attempt.then(
		() => {
			if (excalidrawPersistQueues.get(normalizedPath) === attempt) {
				excalidrawPersistQueues.delete(normalizedPath);
			}
		},
		() => {
			if (excalidrawPersistQueues.get(normalizedPath) === attempt) {
				excalidrawPersistQueues.delete(normalizedPath);
			}
		},
	);
	return attempt;
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
	if (!isTauri() || !getVaultPath() || !path) return Promise.resolve(false);
	const normalizedPath = normalizeTabPath(path);
	const previous =
		textPersistQueues.get(normalizedPath) ?? Promise.resolve(false);
	const attempt = previous
		.catch(() => false)
		.then(async () => {
			if (reseedGuard.has(normalizedPath)) return false;
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
				await writeVaultFile(path, content);
				trackSelfWrittenPath(path);
				setTabs((prev) => reseedTextTab(prev, path, content));
				// NOTE: autosave only writes — .tex compiles are manual now
				// (⌘S / compile button); see compileTexOnManualSave.
				return true;
			} catch (e) {
				notifyError(errorText(e));
				return false;
			}
		});
	textPersistQueues.set(normalizedPath, attempt);
	void attempt.then(
		() => {
			if (textPersistQueues.get(normalizedPath) === attempt) {
				textPersistQueues.delete(normalizedPath);
			}
		},
		() => {
			if (textPersistQueues.get(normalizedPath) === attempt) {
				textPersistQueues.delete(normalizedPath);
			}
		},
	);
	return attempt;
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

	for (const tab of currentTabs) {
		if (tab.id === paperTabId || tab.path === toAbs) {
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
			tab.id === notesTabId ||
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
	updated: Partial<PaperMetadata>,
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

			const nextMeta: PaperMetadata = {
				...(tab.paperMeta ?? ({} as PaperMetadata)),
				...updated,
			};

			const nextTitle =
				tab.kind === "paper"
					? nextMeta.title?.trim() || basenameOf(tab.path)
					: tab.title;

			return {
				...tab,
				title: nextTitle,
				paperMeta: nextMeta,
			};
		}),
	);

	void applyDiskChange(notesAbs);
}
