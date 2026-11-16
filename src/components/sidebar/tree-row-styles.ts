/**
 * Interaction tones shared by sidebar tree rows, the writing outline and the
 * Zen session list: muted at rest, primary text color while hovered. Selected
 * rows and their actions override both states with the inverted sidebar
 * foreground.
 */
export const TREE_ROW_TEXT_STATE =
	"text-muted-foreground hover:text-foreground";

/** Row interaction states shared by the reading tree and the writing sidebar. */
export const FILE_TREE_ROW_STATE = `${TREE_ROW_TEXT_STATE} transition-colors duration-[var(--motion-duration-micro)] ease-[var(--motion-ease-out)] hover:bg-sidebar-accent/80 active:not-has-[[data-tex-compile]:active]:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/80`;
export const FILE_TREE_ROW_SELECTED_STATE =
	"bg-sidebar-primary/75 text-sidebar-primary-foreground hover:text-sidebar-primary-foreground hover:bg-sidebar-primary/75 active:not-has-[[data-tex-compile]:active]:bg-sidebar-primary/75 [&_svg]:text-sidebar-primary-foreground/90";
/** `j/k` cursor: exactly the hover material, not the selected (opened) row. */
export const FILE_TREE_ROW_CURSOR_STATE =
	"bg-sidebar-accent/80 text-foreground";

/** Content inset shared by every row: base padding plus one step per level. */
export const TREE_ROW_INSET_PX = 10;
export const TREE_ROW_INDENT_STEP_PX = 12;
