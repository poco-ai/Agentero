export {
	basenameOf,
	createPlaceholderTab,
	ensureFullLibraryTab,
	insertPlaceholderTab,
	normalizeTabPath,
	patchTab,
	remapPathUnder,
	remapTabsUnderPath,
	removeTab,
	removeTabsUnderPath,
	splitPaneIdForPath,
	tabIdForPath,
} from "@/lib/workspace/tabs/model";
export {
	createNotesSplitPane,
	isPaperContentTab,
	paperReadingPlacements,
	readingPairCloseIds,
	reseedMarkdownTab,
	reseedNotesTab,
	syncTabSeedsForPath,
	tabHasNotesSplit,
	tabIsPaperNotes,
	tabNotesEligible,
} from "@/lib/workspace/tabs/notes-split";
export {
	extractTabsFromLayout,
	loadPersistedTabs,
	panelPersistParams,
	savePersistedTabs,
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
	SplitDirection,
} from "@/lib/workspace/tabs/types";
