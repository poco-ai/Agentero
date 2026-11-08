/**
 * Line numbers use the code face and sit slightly below body text so they
 * read as editor chrome rather than note content.
 */
export const markdownSourceLineNumberStyle = {
	fontFamily: "var(--font-mono)",
	fontSize: "0.8em",
} as const;

/**
 * Bound the whole source surface (gutters included) to the WYSIWYG text
 * measure. Constraining only `.cm-line` would leave the gutter pinned to the
 * pane edge when the text column is centered.
 */
export function markdownSourceSurfaceStyle(markdownMaxWidth: number): {
	maxWidth?: number;
} {
	return markdownMaxWidth > 0 ? { maxWidth: markdownMaxWidth } : {};
}
