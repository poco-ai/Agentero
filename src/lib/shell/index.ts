export { filterByFuzzy } from "@/lib/shell/commands/match";
export type { AppCommand, PaletteMode } from "@/lib/shell/commands/types";
export { readDocWindowParams } from "@/lib/shell/doc-window";
export {
	cleanupImportTempPaths,
	dataTransferHasFiles,
	isImportTempPath,
	pathsFromDataTransfer,
	type ResolvedDropPdf,
	resolveDroppedPdfPaths,
	snapshotDataTransfer,
} from "@/lib/shell/external-file-drop";
export {
	type FeatureViewType,
	isFeatureViewType,
	readFeatureWindowView,
} from "@/lib/shell/feature-window";
export { moveDocToWindow, moveFeatureToWindow } from "@/lib/shell/leaf";
export {
	closeSettingsWindow,
	openSettingsWindow,
	toggleSettingsWindow,
} from "@/lib/shell/settings-window";
export {
	formatModShortcut,
	formatShortcut,
	formatShortcutById,
	resolveShortcutId,
	type ShortcutDef,
	type ShortcutGroup,
	type ShortcutId,
	shortcutsByGroup,
} from "@/lib/shell/shortcuts";
export {
	type AgentSessionOpenRequest,
	addPaperSearchDraft,
	bumpLookupOpenSignal,
	clearAgentSessionOpenRequest,
	clearPaperSearchDraft,
	clearUiVaultState,
	layout,
	openPalette,
	type PaperSearchDraftGroup,
	registerLayoutController,
	setAgentPanelMounted,
	setCommandOpen,
	setFeaturePoppedOut,
	setRightSidebarOpenState,
	setRightSidebarTab,
	setSettingsOpenState,
	setSidebarCollapsedState,
	setSkillImportDraft,
	setZoteroOpen,
	setZoteroSyncOpen,
	shiftPaperSearchDraft,
	toggleSidebar,
	uiStore,
} from "@/lib/shell/ui-store";
export {
	openRightTab,
	requestOpenAgentSession,
	toggleChat,
} from "@/lib/shell/ui-window-actions";
export {
	listenAgentOpenSession,
	listenAgentSessionHandoff,
	listenWorkspaceActive,
	type WorkspaceActiveChangedPayload,
} from "@/lib/shell/workspace-broadcast";
