/**
 * Extension predicates with no Tauri / i18n imports so render-only modules can
 * classify a path without pulling in the filesystem client.
 */

export function isMarkdownPath(path: string): boolean {
	return /\.(md|mdx|markdown)$/i.test(path);
}

export function isTextOpenable(path: string): boolean {
	return (
		isMarkdownPath(path) ||
		/\.(txt|json|bib|tex|html?|css|ts|tsx|js|jsx|rs|toml|yaml|yml|excalidraw)$/i.test(
			path,
		)
	);
}
