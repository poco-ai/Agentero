export {
	collectUserPromptTexts,
	findLastUserMessageIndex,
	nextHistoryIndexOnDown,
	nextHistoryIndexOnUp,
	placeCaretAtEnd,
	shouldNavigateHistoryDown,
	shouldNavigateHistoryUp,
	shouldRecallPreviousPrompt,
} from "@/lib/ui/prompt-recall";
export {
	isTagColorId,
	TAG_COLOR_IDS,
	type TagColorId,
	tagChipStyle,
	tagSwatchStyle,
} from "@/lib/ui/tag-colors";
export {
	applyUiTheme,
	DEFAULT_UI_THEME,
	isKnownUiTheme,
	loadUiThemes,
	UI_THEMES,
	type UiThemeDef,
} from "@/lib/ui/theme";
