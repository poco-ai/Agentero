export {
	basenameOf,
	createPlaceholderTab,
	ensureFullLibraryTab,
	insertPlaceholderTab,
	normalizeTabPath,
	patchFromTabResources,
	patchTab,
	remapPathUnder,
	remapTabsUnderPath,
	removeTab,
	removeTabsUnderPath,
	SPLIT_PANE_ID_MARKER,
	splitPaneIdForPath,
	tabIdForPath,
} from "@/lib/workspace/tabs/model";
export {
	applyMarkdownConflictChoice,
	createNotesSplitPane,
	findNotesPaneForReplacement,
	findPaperBodyForNotes,
	isPaperContentTab,
	paperReadingPlacements,
	readingPairCloseIds,
	refreshPdfTab,
	seedTabs,
	syncTabSeedsForPath,
	tabHasNotesSplit,
	tabIsPaperNoteDocument,
	tabIsPaperNotes,
	tabNotesEligible,
} from "@/lib/workspace/tabs/notes-split";
export {
	extractTabsFromLayout,
	loadPersistedTabs,
	loadWindowVaultLayout,
	panelPersistParams,
	persistedLayoutIsUnreadable,
	savePersistedTabs,
	saveWorkspaceLayout,
	shouldWritePersistedLayout,
	workspaceLayoutStorageKey,
} from "@/lib/workspace/tabs/persist";
export {
	loadTabResources,
	revokeTabMediaSources,
} from "@/lib/workspace/tabs/resources";
export {
	createTranslationSplitPane,
	translationSplitPlacement,
} from "@/lib/workspace/tabs/translation-split";
export type {
	DocTab,
	OpenPlacement,
	ReadingColumns,
	SplitDirection,
	TabResources,
} from "@/lib/workspace/tabs/types";
