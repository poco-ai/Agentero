import type { LucideIcon } from "lucide-react";
import {
	BookMarked,
	FileCode2,
	FileImage,
	FileJson,
	FileText,
	FileType2,
	Folder,
	Rss,
	ScrollText,
	Sigma,
	Telescope,
} from "lucide-react";
import { plazaMentionSource } from "@/lib/agent/plaza-mention";
import {
	formatPaperTreeLabel,
	type PaperTreeLabelMode,
} from "@/lib/paper/tree-label";

/**
 * Normalize a vault-relative (or absolute-looking) path for kind / icon lookup.
 * Strips trailing slashes; keeps internal case (Vault paths are case-sensitive on some FS).
 */
export function normalizeContextPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
}

/** Build a Set of normalized paths for O(1) chip kind lookup. */
export function toPathSet(
	paths: Iterable<string> | null | undefined,
): ReadonlySet<string> {
	const set = new Set<string>();
	if (!paths) return set;
	for (const p of paths) {
		const n = normalizeContextPath(p);
		if (n) set.add(n);
	}
	return set;
}

export type ContextPathIconOptions = {
	/** Vault-relative directories (org folders, notes dirs, paper folders, …). */
	directoryPaths?: ReadonlySet<string> | null;
	/**
	 * Vault-relative **paper** folder paths (marker-based leaves under `papers/`).
	 * Takes priority over generic folder icon — matches file-tree `ScrollText`.
	 */
	paperPaths?: ReadonlySet<string> | null;
};

/**
 * Whether a context path should use a folder icon.
 *
 * Priority:
 * 1. Trailing slash on the raw path → directory
 * 2. Exact match in `directoryPaths` (from Vault tree) → directory
 * 3. Basename has a file-like extension → file
 * 4. No extension → directory (paper folders, org folders, notes dirs)
 */
export function isDirectoryContextPath(
	path: string,
	directoryPaths?: ReadonlySet<string> | null,
): boolean {
	const raw = path.replace(/\\/g, "/");
	if (raw.endsWith("/")) return true;

	const norm = normalizeContextPath(path);
	if (!norm) return false;

	if (directoryPaths?.has(norm)) return true;

	const base = norm.includes("/") ? (norm.split("/").pop() ?? norm) : norm;
	// Dotfiles like `.gitignore` count as files; `v1.0`-style dirs rely on tree set.
	if (hasFileLikeExtension(base)) return false;

	// Unknown path with no extension: treat as folder (drag of paper / org dir).
	return true;
}

export function isPaperContextPath(
	path: string,
	paperPaths?: ReadonlySet<string> | null,
): boolean {
	if (!paperPaths?.size) return false;
	const norm = normalizeContextPath(path);
	return Boolean(norm && paperPaths.has(norm));
}

/** Basename looks like `name.ext` with a short alnum extension. */
function hasFileLikeExtension(base: string): boolean {
	if (!base || base === "." || base === "..") return false;
	// Leading-dot only (`.env`) → file; `name.tar.gz` → file via last segment.
	const m = base.match(/\.([a-z0-9]{1,12})$/i);
	if (!m) return false;
	return true;
}

/**
 * Chip / mention **display** label: last path segment (paper folder name, file name).
 * Full Vault-relative path stays in tooltips and is still sent to the Agent.
 */
export function contextPathDisplayName(path: string): string {
	const norm = normalizeContextPath(path);
	if (!norm) return path;
	const base = norm.includes("/") ? (norm.split("/").pop() ?? norm) : norm;
	return base || path;
}

export type ContextPathLabelOptions = {
	/** Vault-relative paper folder paths. */
	paperPaths?: ReadonlySet<string> | readonly string[] | null;
	/**
	 * Catalog rows keyed by vault-relative paper path.
	 * Used with `paperTreeLabelMode` (same as file tree).
	 */
	paperMetaByRelPath?: ReadonlyMap<
		string,
		{ title?: string; authors?: string[]; year?: number | null }
	> | null;
	/** Settings → General paper tree label mode (default title-author). */
	paperTreeLabelMode?: PaperTreeLabelMode | null;
};

/**
 * Resolve the paper folder for a context path, if any.
 * Exact paper path or a file under a paper → that paper root.
 */
export function paperContextRoot(
	path: string,
	paperPaths?: ReadonlySet<string> | readonly string[] | null,
): string | null {
	const norm = normalizeContextPath(path);
	if (!norm || !paperPaths) return null;
	const set =
		paperPaths instanceof Set
			? paperPaths
			: new Set([...paperPaths].map(normalizeContextPath).filter(Boolean));
	if (set.has(norm)) return norm;
	// Longest matching paper prefix
	let best: string | null = null;
	for (const paper of set) {
		if (!paper) continue;
		if (norm.startsWith(`${paper}/`)) {
			if (!best || paper.length > best.length) best = paper;
		}
	}
	return best;
}

/**
 * Display label for chips / @ menu, matching file-tree paper labels when possible.
 * Non-paper paths keep basename; papers use `formatPaperTreeLabel` + catalog meta.
 */
export function contextPathLabel(
	path: string,
	options?: ContextPathLabelOptions | null,
): string {
	const norm = normalizeContextPath(path);
	if (!norm) return path;

	const paperRoot = paperContextRoot(norm, options?.paperPaths ?? null);
	if (paperRoot) {
		const folderName = paperRoot.includes("/")
			? (paperRoot.split("/").pop() ?? paperRoot)
			: paperRoot;
		const raw = options?.paperMetaByRelPath?.get(paperRoot) ?? null;
		const mode = options?.paperTreeLabelMode ?? "title-author";
		const meta = raw
			? {
					title: raw.title ?? "",
					authors: raw.authors ?? [],
					year: raw.year ?? undefined,
				}
			: null;
		return formatPaperTreeLabel(mode, meta, folderName);
	}

	return contextPathDisplayName(norm);
}

/**
 * Lucide icon for a Vault context chip / mention row.
 * Paper folders → ScrollText (same as file tree); other folders → Folder;
 * files → type-specific (PDF, image, code, …).
 */
export function contextPathIcon(
	path: string,
	options?: ContextPathIconOptions | null,
): LucideIcon {
	const opts = options ?? {};

	// Virtual plaza mentions mirror the plaza source icons (telescope / rss).
	const plazaSource = plazaMentionSource(path);
	if (plazaSource === "feed") return Rss;
	if (plazaSource === "arxiv-rec") return Telescope;

	if (isPaperContextPath(path, opts.paperPaths)) {
		return ScrollText;
	}
	if (isDirectoryContextPath(path, opts.directoryPaths)) {
		return Folder;
	}
	const base = normalizeContextPath(path).split("/").pop()?.toLowerCase() ?? "";
	if (/\.pdf$/i.test(base)) return FileType2;
	if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(base)) return FileImage;
	if (/\.tex$/i.test(base)) return Sigma;
	if (/\.bib$/i.test(base)) return BookMarked;
	if (/\.json$/i.test(base)) return FileJson;
	if (/\.(ts|tsx|js|jsx|rs|toml|py|go|java|c|cpp|h|hpp)$/i.test(base)) {
		return FileCode2;
	}
	if (/\.(html?|xml|css|scss)$/i.test(base)) return FileCode2;
	// Markdown and everything else
	return FileText;
}
