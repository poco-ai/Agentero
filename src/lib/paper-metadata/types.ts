import {
	coercePaperTags,
	type PaperTag,
	type PaperTagInput,
} from "@/lib/tag-colors";

export type { PaperTag, PaperTagInput };

/** Ensure `tags` is a normalized `PaperTag[]`. */
export function withNormalizedTags(meta: PaperMetadata): PaperMetadata {
	return {
		...meta,
		tags: coercePaperTags(meta.tags),
	};
}

/** Creator from Translator / Zotero item mapping. */
export type PaperCreator = {
	firstName?: string;
	lastName?: string;
	name?: string;
	creatorType?: string;
};

/**
 * Paper metadata: catalog.sqlite row (see docs/backend/catalog.md).
 * Magic-wand / Translator results map **directly** into these fields.
 *
 * **Authoritative store is** Vault `.agentero/catalog.sqlite`; `metadata.json`
 * is a write-side projection for rescan / external tools (not the read path).
 *
 * **Paper folder = minimal unit** under `papers/` at any depth.
 * PDF preview: local file first → download if missing → remote `pdf_url`.
 * HTML preview: remote `html_url` only.
 */
export type PaperMetadata = {
	id: string;
	/** Vault-relative paper folder path when known (catalog). */
	path?: string;
	type: "arxiv" | "pdf" | "html" | "doi" | "other";
	title: string;
	/** Display names */
	authors: string[];
	/** Full creators (roles preserved from Translator) */
	creators?: PaperCreator[];
	year?: number;
	/** Raw date string from Translator */
	date?: string;
	abstract?: string;
	/**
	 * Tags from catalog: bare string or `{ name, color? }`.
	 * UI should coerce via `coercePaperTags`.
	 */
	tags: PaperTagInput[];
	arxiv_id?: string;
	doi?: string;
	isbn?: string;
	issn?: string;
	pmid?: string;
	/** Journal / proceedings / book title */
	publication?: string;
	volume?: string;
	issue?: string;
	pages?: string;
	publisher?: string;
	place?: string;
	series?: string;
	language?: string;
	/** Remote PDF URL only (e.g. https://arxiv.org/pdf/1706.03762) */
	pdf_url?: string;
	/** Remote HTML URL only (e.g. https://arxiv.org/html/1706.03762) */
	html_url?: string;
	source_url?: string;
	body_source?: "latex" | "html" | "pdf" | "ocr";
	body_quality?: "high" | "medium" | "low";
	bibtex_key?: string;
	citation_count?: number;
	/** Translator itemType, e.g. journalArticle */
	zotero_item_type?: string;
	/** libraryCatalog, e.g. DOI.org (Crossref) */
	meta_source?: string;
	/** Translator extra residue */
	extra?: string;
	summary?: string;
	status: "pending" | "importing" | "completed" | "failed";
	/** Whether paper-reader workflow has finished for this paper. */
	is_read?: boolean;
	added_at: string;
	updated_at: string;
};

/** Remote http(s) URL (HTML preview; PDF download candidate / fallback). */
export type RemoteAsset = { url: string };

/** How the PDF viewer source was resolved. */
export type PaperPdfOrigin = "local" | "remote";

/** Direct-child names that mark a directory as a paper folder. */
export const PAPER_FILE_MARKERS = [
	"NOTES.md",
	"PAPER.md",
	"metadata.json",
] as const;

/** Direct-child directory names that mark a paper folder. */
export const PAPER_DIR_MARKERS = ["source", "assets", "marks"] as const;

/**
 * Reasons a paper row should show the Download icon (for hover tooltip).
 * Keys are i18n suffixes under `sidebar:fileTree.downloadReason.*`.
 *
 * Readable body: **TeX OR PAPER.md** is enough (prefer TeX — if TeX exists, PAPER.md is not required).
 */
export type PaperDownloadReason = "noPdf" | "noBody";

/**
 * How paper folders are labeled in the file tree (Settings → General).
 * Disk folder names stay unchanged; this is display-only.
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
 *
 * Directories before files. `folder` mode mixes org folders and papers by name.
 * Other modes: org folders first (by name), then papers by the chosen key.
 */
export type PaperTreeSortMode =
	| "folder"
	| "title"
	| "author"
	| "year-desc"
	| "year-asc"
	| "added-desc";

export const PAPER_TREE_SORT_MODES: readonly PaperTreeSortMode[] = [
	"folder",
	"title",
	"author",
	"year-desc",
	"year-asc",
	"added-desc",
] as const;

export function isPaperTreeSortMode(v: unknown): v is PaperTreeSortMode {
	return (
		typeof v === "string" &&
		(PAPER_TREE_SORT_MODES as readonly string[]).includes(v)
	);
}
