export {
	applyDiskChange,
	closePlazaTabs,
	closeTab,
	closeTabOrWindow,
	closeTabsUnderPath,
	cycleActiveTab,
	dirtyVaultPaths,
	ensureLibraryTabPresent,
	handleActivePanelChange,
	hydratePlaceholderTabs,
	navigateWiki,
	openGraphPath,
	openPaper,
	openPaperNotes,
	openPath,
	openPlazaSource,
	openTab,
	openTabNotes,
	openVaultRel,
	persistFile,
	reopenClosedTab,
	selectFileNode,
	selectLibrary,
	selectPlaza,
	selectTrash,
	splitActivePane,
	toggleNotesSplit,
} from "@/lib/workspace/actions";
export { dockHandle, registerDockHandle } from "@/lib/workspace/dock-registry";
export {
	installDockviewSashFrameLoop,
	isDockviewSashTarget,
} from "@/lib/workspace/dockview-sash";
export { agenteroDockTheme } from "@/lib/workspace/dockview-theme";
export { evictPdfBuffers, nextPdfLru } from "@/lib/workspace/pdf-retention";
export {
	clearClosedTabs,
	getActiveTabId,
	getTabs,
	initWorkspaceStore,
	refreshTabNotes,
	setActiveTabId,
	setDockLayout,
	setEditorLru,
	setPdfLru,
	setTabs,
	toggleTabHtmlMode,
	updateTab,
	workspaceStore,
} from "@/lib/workspace/store";
export {
	isSplitDragPayload,
	readDraggedVaultPaths,
} from "@/lib/workspace/tab-dnd";
export {
	basenameOf,
	createPlaceholderTab,
	type DocTab,
	loadTabResources,
	normalizeTabPath,
	type OpenPlacement,
	panelPersistParams,
	remapPathUnder,
	remapTabsUnderPath,
	type SplitDirection,
	savePersistedTabs,
	tabHasNotesSplit,
	tabIdForPath,
	tabIsPaperNotes,
	tabNotesEligible,
} from "@/lib/workspace/tabs";
export {
	type CenterViewMode,
	imageMimeFromPath,
	isImageViewerSource,
} from "@/lib/workspace/viewer";
export type { PdfViewerHandle } from "@/lib/workspace/viewer/pdf-viewer-registry";
