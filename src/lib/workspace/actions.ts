/**
 * Workspace actions. Plain functions over the vanilla stores (`getState()`
 * replaces the old App ref mirrors); dockview is driven through the registered
 * dock handle.
 *
 * Implementations live in `./navigation` (tabs, paper, NOTES), `./persistence`
 * (save and disk reload), and `./viewer-actions` (TeX, citations, wiki jumps).
 * This module re-exports that public surface.
 */

export {
	activatePaperWithNotes,
	closePlazaTabs,
	closeTab,
	closeTabOrWindow,
	closeTabsUnderPath,
	closeWindow,
	cycleActiveTab,
	ensureLibraryTabPresent,
	handleActivePanelChange,
	hydratePlaceholderTabs,
	openFolderLibrary,
	openPaper,
	openPaperNotes,
	openPath,
	openPlazaSource,
	openRemoteArxivPaper,
	openTab,
	openTabNotes,
	rehydrateMisclassifiedPaperTabs,
	remapMovedWorkspacePaths,
	reopenClosedTab,
	selectFileNode,
	selectLibrary,
	selectTrash,
	setNotesSplit,
	syncRenamedPaperTabs,
	syncUpdatedPaperTabs,
	toggleNotesSplit,
} from "./navigation";
export type { DiskChangeSink } from "./persistence";
export {
	applyDiskChange,
	dirtyVaultPaths,
	persistExcalidrawFile,
	persistFile,
	persistTextFile,
} from "./persistence";
export {
	closeTexLive,
	compileTexOnManualSave,
	compileTexOnSave,
	compileTexProject,
	isLocalHtmlLink,
	navigateWiki,
	openCitation,
	openGraphPath,
	openHtmlPreviewLink,
	openTexLive,
	openTexPdf,
	openTranslationTab,
	openVaultRel,
	scheduleCitationJump,
	splitActivePane,
	tryOpenCitationHref,
} from "./viewer-actions";
