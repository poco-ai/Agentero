/**
 * DockWorkspace host: assembles `centerProps` from the domain stores and owns
 * the workspace sync effects (PDF / editor keep-alive LRUs, layout persistence,
 * empty-strip Library fallback, tree-selection follow). Library query
 * keystrokes and PDF annotation updates re-render this host only — never the
 * whole App.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { registerPdfHandle } from "@/components/viewer";
import {
	DockWorkspace,
	type WorkspaceExternalDrop,
} from "@/components/workspace/dock-workspace";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import { isLibraryVirtualPath } from "@/lib/paper/api";
import {
	openLibraryPaper,
	rescanLibraryPapers,
} from "@/lib/paper/library-actions";
import { setLibraryQuery } from "@/lib/paper/library-store";
import {
	setTabAsks,
	setTabHighlights,
	setTabVisualTraces,
} from "@/lib/pdf/annotations-store";
import type { LibraryColumnPref } from "@/lib/settings";
import { resolveFontFamilyCss } from "@/lib/settings";
import { patchSettings } from "@/lib/settings/react-store";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { joinVaultPath } from "@/lib/vault";
import { handleTrashChanged } from "@/lib/vault/actions";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { refreshTree, setTreeSelectedPath } from "@/lib/vault/store";
import { renameWikiHeadingAction } from "@/lib/wiki/actions";
import {
	closePlazaTabs,
	closeTab,
	compileTexOnManualSave,
	ensureLibraryTabPresent,
	handleActivePanelChange,
	hydratePlaceholderTabs,
	openTab,
	openTabNotes,
	openTranslationTab,
	persistExcalidrawFile,
	persistFile,
	persistTextFile,
	rehydrateMisclassifiedPaperTabs,
} from "@/lib/workspace/actions";
import { registerDockHandle } from "@/lib/workspace/dock-registry";
import { evictPdfBuffers, nextPdfLru } from "@/lib/workspace/pdf-retention";
import {
	setDockLayout,
	setEditorLru,
	setPdfLru,
	setTabs,
	toggleTabHtmlMode,
	updateTab,
} from "@/lib/workspace/store";
import { savePersistedTabs } from "@/lib/workspace/tabs";
import { viewerModeSpec } from "@/lib/workspace/viewer";

/**
 * Number of PDF *viewers* kept mounted (most recent first). Dockview already
 * keeps PDF panel shells mounted (`renderer: 'always'`); this LRU only gates
 * EmbedPDF/PDFium so switching among recent PDFs is instant without holding
 * every open document on the main thread. Which modes join this pool is
 * declared per mode in the viewer registry (`keepAlive: "pdf"`).
 */
const PDF_TAB_MOUNT_LRU = 2;

/**
 * Number of Plate Markdown editors kept mounted (most recent first). Same
 * shell/LRU split as PDF: switching back to a recent note skips plugin init
 * and full-document deserialization without retaining every open editor.
 * Raised to 4 so a few split notes stay warm; heavier documents deserialize
 * through the content-trimmed remark pipeline. Pool membership is declared
 * per mode in the viewer registry (`keepAlive: "editor"`).
 */
const EDITOR_TAB_MOUNT_LRU = 4;

function handleWorkspaceDrop(drop: WorkspaceExternalDrop): void {
	const path = drop.paths[0];
	if (!path) return;
	openTab(path, {
		placement: {
			direction: drop.direction,
			referencePanelId: drop.referencePanelId,
		},
		skipDefaultNotes: true,
	});
}

function handleLibraryColumnsChange(cols: LibraryColumnPref[]): void {
	patchSettings({ libraryColumns: cols });
}

export function WorkspaceHost() {
	const { t } = useTranslation(["app"]);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const treeLoading = useVaultStore((s) => s.treeLoading);
	const tabs = useWorkspaceStore((s) => s.tabs);
	const activeTabId = useWorkspaceStore((s) => s.activeTabId);
	const dockLayout = useWorkspaceStore((s) => s.dockLayout);
	const pdfLru = useWorkspaceStore((s) => s.pdfLru);
	const editorLru = useWorkspaceStore((s) => s.editorLru);
	const libraryPapers = useLibraryStore((s) => s.papers);
	const libraryLoading = useLibraryStore((s) => s.loading);
	const libraryQuery = useLibraryStore((s) => s.query);
	const libraryScopePath = useLibraryStore((s) => s.scopePath);
	const rescanning = useLibraryStore((s) => s.rescanning);
	const trashReloadSignal = useLibraryStore((s) => s.trashReloadSignal);
	const libraryColumns = useSettings((s) => s.libraryColumns);
	const editorFontSize = useSettings((s) => s.editorFontSize);
	const textFontFamily = useSettings((s) => s.textFontFamily);
	const editorLineHeight = useSettings((s) => s.editorLineHeight);
	const showEditorToolbar = useSettings((s) => s.showEditorToolbar);
	const plazaEnabled = useSettings((s) => s.plazaEnabled);
	const [visiblePanelIds, setVisiblePanelIds] = useState<string[]>([]);

	const activeTab = useMemo(
		() => tabs.find((tab) => tab.id === activeTabId) ?? null,
		[tabs, activeTabId],
	);

	const handleVisiblePanelIdsChange = useCallback((ids: string[]) => {
		setVisiblePanelIds((previous) => {
			if (
				ids.length === previous.length &&
				ids.every((id, index) => id === previous[index])
			) {
				return previous;
			}
			return ids;
		});
	}, []);

	useEffect(() => {
		if (!plazaEnabled) closePlazaTabs();
	}, [plazaEnabled]);

	const visiblePdfIds = useMemo(() => {
		const visible = new Set(visiblePanelIds);
		return tabs
			.filter(
				(tab) =>
					viewerModeSpec(tab.mode).keepAlive === "pdf" && visible.has(tab.id),
			)
			.map((tab) => tab.id);
	}, [tabs, visiblePanelIds]);

	const visibleEditorIds = useMemo(() => {
		const visible = new Set(visiblePanelIds);
		return tabs
			.filter(
				(tab) =>
					viewerModeSpec(tab.mode).keepAlive === "editor" &&
					visible.has(tab.id),
			)
			.map((tab) => tab.id);
	}, [tabs, visiblePanelIds]);

	// Registry keep-alive pool membership of the active tab (drives LRU
	// promotion and PDF-buffer retention below).
	const activePdfId =
		activeTab && viewerModeSpec(activeTab.mode).keepAlive === "pdf"
			? activeTab.id
			: null;
	const activeEditorId =
		activeTab && viewerModeSpec(activeTab.mode).keepAlive === "editor"
			? activeTab.id
			: null;

	// Keep visible/recent PDF panels mounted without bootstrapping every restored PDF.
	useEffect(() => {
		const ids = tabs
			.filter((tab) => viewerModeSpec(tab.mode).keepAlive === "pdf")
			.map((tab) => tab.id);
		if (!ids.length) {
			setPdfLru((previous) => (previous.length ? [] : previous));
			return;
		}
		const promoted = activePdfId
			? [activePdfId, ...visiblePdfIds.filter((id) => id !== activePdfId)]
			: visiblePdfIds;
		setPdfLru((previous) =>
			nextPdfLru(previous, ids, promoted, PDF_TAB_MOUNT_LRU),
		);
	}, [activePdfId, tabs, visiblePdfIds]);

	// Same keep-alive for Markdown editors (and the CodeMirror text editor):
	// evicted tabs drop back to a placeholder and re-deserialize only when
	// their group exposes them again.
	useEffect(() => {
		const ids = tabs
			.filter((tab) => viewerModeSpec(tab.mode).keepAlive === "editor")
			.map((tab) => tab.id);
		if (!ids.length) {
			setEditorLru((previous) => (previous.length ? [] : previous));
			return;
		}
		const promoted = activeEditorId
			? [
					activeEditorId,
					...visibleEditorIds.filter((id) => id !== activeEditorId),
				]
			: visibleEditorIds;
		setEditorLru((previous) =>
			nextPdfLru(previous, ids, promoted, EDITOR_TAB_MOUNT_LRU),
		);
	}, [activeEditorId, tabs, visibleEditorIds]);

	// Local PDF ArrayBuffers are large and keep PDFium documents alive indirectly.
	// Evicted tabs become placeholders and reload only when one of their groups
	// exposes them again.
	useEffect(() => {
		const retained = new Set([
			...pdfLru,
			...visiblePanelIds,
			...(activePdfId ? [activePdfId] : []),
		]);
		setTabs((previous) => evictPdfBuffers(previous, retained));
	}, [activePdfId, pdfLru, visiblePanelIds]);

	// Tree selection / create-parent follows the active document.
	// Scoped library keeps the tree highlight on the org folder. The resident
	// full Library tab is active by default and must not claim the tree
	// selection, otherwise every folder click snaps the cursor to `papers/`.
	const selectedPath = activeTab?.path ?? null;
	useEffect(() => {
		if (!selectedPath) return;
		if (isLibraryVirtualPath(selectedPath)) {
			if (libraryScopePath && vaultPath) {
				setTreeSelectedPath(joinVaultPath(vaultPath, libraryScopePath));
			}
			return;
		}
		setTreeSelectedPath(selectedPath);
	}, [selectedPath, libraryScopePath, vaultPath]);

	// Restore only panels visible in a dock group. Hidden historical tabs hydrate
	// on activation, avoiding concurrent reads and PDFium mounts during startup.
	useEffect(() => {
		const ids = visiblePanelIds.length
			? visiblePanelIds
			: activeTabId
				? [activeTabId]
				: [];
		if (!ids.length) return;
		if (!treeLoading) rehydrateMisclassifiedPaperTabs();
		hydratePlaceholderTabs(ids);
	}, [activeTabId, visiblePanelIds, treeLoading]);

	// Library is resident: with a Vault open its tab must exist (fresh open,
	// restore from a layout saved without it, or after other tabs closed).
	const hasLibraryTab = useMemo(
		() => tabs.some((t) => isLibraryVirtualPath(t.path)),
		[tabs],
	);
	useEffect(() => {
		if (!vaultPath || hasLibraryTab) return;
		ensureLibraryTabPresent();
	}, [vaultPath, hasLibraryTab]);

	// Layout alone is persisted (panels + order + active + path/mode in params).
	useEffect(() => {
		savePersistedTabs(dockLayout);
	}, [dockLayout]);

	// Domain callbacks pinned with useCallback so the per-domain prop objects
	// below keep their identity across host re-renders.
	const handleRescan = useCallback(() => void rescanLibraryPapers(), []);
	const handleAssetsChanged = useCallback(() => {
		if (vaultPath) void refreshTree(vaultPath);
	}, [vaultPath]);
	const handleTrashReload = useCallback(() => void handleTrashChanged(), []);
	const handleOpenSettings = useCallback(
		() => openSettingsWindow("translate"),
		[],
	);

	/**
	 * Memoized DocView props — must not be an inline object in JSX, or
	 * DocView's React.memo never bails out. Each domain is memoized on its own
	 * state so e.g. library query keystrokes only rebuild `libraryProps`;
	 * DocView's domain-aware comparator then keeps PDF / editor panes mounted
	 * without re-rendering.
	 */
	const libraryProps = useMemo(
		() => ({
			papers: libraryPapers,
			loading: libraryLoading,
			query: libraryQuery,
			onQueryChange: setLibraryQuery,
			scopePath: libraryScopePath,
			columns: libraryColumns,
			onColumnsChange: handleLibraryColumnsChange,
			rescanning,
			onOpenPaper: openLibraryPaper,
			onRescan: handleRescan,
		}),
		[
			libraryPapers,
			libraryLoading,
			libraryQuery,
			libraryScopePath,
			libraryColumns,
			rescanning,
			handleRescan,
		],
	);
	const editorProps = useMemo(
		() => ({
			fontSize: editorFontSize,
			fontFamily: resolveFontFamilyCss(textFontFamily, "text"),
			lineHeight: editorLineHeight,
			showToolbar: showEditorToolbar,
			notesPlaceholder: t("editor.notesPlaceholder"),
			markdownPlaceholder: t("editor.markdownPlaceholder"),
			onPersistFile: persistFile,
			onAssetsChanged: handleAssetsChanged,
			onTabPatch: updateTab,
			onRenameHeading:
				vaultPath && !isRemoteVaultHandle(vaultPath)
					? renameWikiHeadingAction
					: undefined,
		}),
		[
			editorFontSize,
			textFontFamily,
			editorLineHeight,
			showEditorToolbar,
			t,
			vaultPath,
			handleAssetsChanged,
		],
	);
	const pdfProps = useMemo(
		() => ({
			onOpenSettings: handleOpenSettings,
			registerHandle: registerPdfHandle,
			onHighlightsChange: setTabHighlights,
			onAsksChange: setTabAsks,
			onVisualTracesChange: setTabVisualTraces,
			onOpenTranslationTab: openTranslationTab,
		}),
		[handleOpenSettings],
	);
	const excalidrawProps = useMemo(
		() => ({
			onPersistFile: persistExcalidrawFile,
			onTabPatch: updateTab,
		}),
		[],
	);
	const textProps = useMemo(
		() => ({
			onPersistFile: persistTextFile,
			// ⌘S: save landed — TeX compiles, everything else no-ops inside.
			onManualSave: (path: string) => void compileTexOnManualSave(path),
			onTabPatch: updateTab,
		}),
		[],
	);
	const centerProps = useMemo(
		() => ({
			vaultPath,
			library: libraryProps,
			editor: editorProps,
			pdf: pdfProps,
			excalidraw: excalidrawProps,
			text: textProps,
			onTrashChanged: handleTrashReload,
			trashReloadSignal,
		}),
		[
			vaultPath,
			libraryProps,
			editorProps,
			pdfProps,
			excalidrawProps,
			textProps,
			handleTrashReload,
			trashReloadSignal,
		],
	);

	const keepMountedIds = useMemo(
		() => [
			...pdfLru,
			...editorLru,
			...visiblePanelIds,
			...(activeTabId ? [activeTabId] : []),
		],
		[pdfLru, editorLru, visiblePanelIds, activeTabId],
	);

	return (
		<DockWorkspace
			ref={registerDockHandle}
			tabs={tabs}
			activePanelId={activeTabId}
			layout={dockLayout}
			keepMountedIds={keepMountedIds}
			centerProps={centerProps}
			onActivePanelChange={handleActivePanelChange}
			onVisiblePanelIdsChange={handleVisiblePanelIdsChange}
			onClosePanel={closeTab}
			onLayoutChange={setDockLayout}
			onToggleHtmlMode={toggleTabHtmlMode}
			onOpenNotesPanel={openTabNotes}
			onExternalDrop={handleWorkspaceDrop}
		/>
	);
}
