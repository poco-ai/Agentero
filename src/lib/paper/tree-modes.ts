/**
 * File-tree display mode types (leaf module — no imports).
 * Settings and tree rendering both depend on these; keeping them
 * dependency-free breaks the settings → paper → vault → agent cycle.
 */

export type PaperTreeLabelMode =
	| "title-author"
	| "title"
	| "author-year-title"
	| "folder";

export const PAPER_TREE_LABEL_MODES: readonly PaperTreeLabelMode[] = [
	"title-author",
	"title",
	"author-year-title",
	"folder",
] as const;

export function isPaperTreeLabelMode(v: unknown): v is PaperTreeLabelMode {
	return (
		typeof v === "string" &&
		(PAPER_TREE_LABEL_MODES as readonly string[]).includes(v)
	);
}

/**
 * How children under each folder are ordered in the file tree (Settings → General).
 * Display-only; does not rename or move disk folders.
 *
 * - `folder`: display label A–Z (uses `paperTreeLabelMode` for papers; org folders by name)
 * - `title` / `author`: catalog fields, missing → folder name
 * - `year-desc` / `year-asc`: publication year; missing year last
 * - `added-desc`: catalog `added_at` newest first; missing last
 * - `manual`: saved sibling order; new papers follow in display-label order
 *
 * Directories before files. Org folders (non-paper directories) before paper folders.
 * `folder` mode: org folders first by name, then papers by display label.
 * Other modes: org folders first (by name), then papers by the chosen key.
 */
export type PaperTreeSortMode =
	| "folder"
	| "title"
	| "author"
	| "year-desc"
	| "year-asc"
	| "added-desc"
	| "manual";

export const PAPER_TREE_SORT_MODES: readonly PaperTreeSortMode[] = [
	"folder",
	"title",
	"author",
	"year-desc",
	"year-asc",
	"added-desc",
	"manual",
] as const;

export function isPaperTreeSortMode(v: unknown): v is PaperTreeSortMode {
	return (
		typeof v === "string" &&
		(PAPER_TREE_SORT_MODES as readonly string[]).includes(v)
	);
}
