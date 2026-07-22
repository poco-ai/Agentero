import { isPaperDirectory } from "@/lib/paper-metadata/detect";
import type {
	PaperMetadata,
	PaperTreeLabelMode,
	PaperTreeSortMode,
} from "@/lib/paper-metadata/types";
import type { FileNode } from "@/lib/vault";

const LOCALE_CMP = { sensitivity: "base" as const };

function cmpName(a: string, b: string): number {
	return a.localeCompare(b, undefined, LOCALE_CMP);
}

function firstAuthorKey(meta: PaperMetadata | null | undefined): string {
	if (!meta?.authors?.length) return "";
	const first = meta.authors.find((a) => a.trim());
	return first?.trim().toLowerCase() ?? "";
}

function yearValue(meta: PaperMetadata | null | undefined): number | null {
	if (typeof meta?.year === "number" && Number.isFinite(meta.year)) {
		return meta.year;
	}
	return null;
}

function addedMs(meta: PaperMetadata | null | undefined): number | null {
	const raw = meta?.added_at?.trim();
	if (!raw) return null;
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : null;
}

/**
 * Recursively sort a file-tree sibling list for display.
 * Papers use catalog metadata when the sort mode needs it; everything else
 * falls back to folder/file name. Does not mutate the input nodes.
 */
export function sortFileTreeNodes(
	nodes: FileNode[],
	mode: PaperTreeSortMode,
	metaByRelPath?: ReadonlyMap<string, PaperMetadata> | null,
	toRelPath?: (absPath: string) => string,
	/**
	 * How paper rows are labeled in the tree. Used when sorting by display name
	 * (`folder` mode and name tie-breaks) so order matches what the user sees.
	 */
	labelMode: PaperTreeLabelMode = "title-author",
): FileNode[] {
	const relOf = (absPath: string) =>
		toRelPath
			? toRelPath(absPath)
			: absPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

	const metaOf = (node: FileNode): PaperMetadata | null => {
		if (!metaByRelPath) return null;
		return metaByRelPath.get(relOf(node.path)) ?? null;
	};

	/** Sort key for directories: papers use tree display label, orgs use folder name. */
	const displayKey = (node: FileNode): string => {
		if (node.kind === "file") return node.name;
		if (isPaperDirectory(node.path, node.children)) {
			return formatPaperTreeLabel(labelMode, metaOf(node), node.name);
		}
		return node.name;
	};

	const compare = (a: FileNode, b: FileNode): number => {
		if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;

		// Files always by name
		if (a.kind === "file") return cmpName(a.name, b.name);

		// Default: mixed org + paper by **display** name (matches tree labels)
		if (mode === "folder") {
			const c = cmpName(displayKey(a), displayKey(b));
			return c !== 0 ? c : cmpName(a.name, b.name);
		}

		const aPaper = isPaperDirectory(a.path, a.children);
		const bPaper = isPaperDirectory(b.path, b.children);

		// Metadata modes: org folders first (by name), then papers by criterion
		if (aPaper !== bPaper) return aPaper ? 1 : -1;
		if (!aPaper && !bPaper) return cmpName(a.name, b.name);

		const am = metaOf(a);
		const bm = metaOf(b);

		if (mode === "title") {
			const at = (am?.title ?? "").trim() || displayKey(a);
			const bt = (bm?.title ?? "").trim() || displayKey(b);
			const c = cmpName(at, bt);
			return c !== 0 ? c : cmpName(a.name, b.name);
		}

		if (mode === "author") {
			const aa = firstAuthorKey(am) || displayKey(a).toLowerCase();
			const ba = firstAuthorKey(bm) || displayKey(b).toLowerCase();
			const c = cmpName(aa, ba);
			return c !== 0 ? c : cmpName(a.name, b.name);
		}

		if (mode === "year-desc" || mode === "year-asc") {
			const ay = yearValue(am);
			const by = yearValue(bm);
			const aMissing = ay === null;
			const bMissing = by === null;
			if (aMissing !== bMissing) return aMissing ? 1 : -1;
			if (ay !== null && by !== null && ay !== by) {
				return mode === "year-desc" ? by - ay : ay - by;
			}
			const c = cmpName(displayKey(a), displayKey(b));
			return c !== 0 ? c : cmpName(a.name, b.name);
		}

		// added-desc
		const at = addedMs(am);
		const bt = addedMs(bm);
		const aMissing = at === null;
		const bMissing = bt === null;
		if (aMissing !== bMissing) return aMissing ? 1 : -1;
		if (at !== null && bt !== null && at !== bt) return bt - at;
		const c = cmpName(displayKey(a), displayKey(b));
		return c !== 0 ? c : cmpName(a.name, b.name);
	};

	return [...nodes].sort(compare).map((n) => {
		if (!n.children?.length) return n;
		// Paper leaves keep children for marker detection but are not expanded;
		// still sort for consistency if inspected.
		return {
			...n,
			children: sortFileTreeNodes(
				n.children,
				mode,
				metaByRelPath,
				toRelPath,
				labelMode,
			),
		};
	});
}

/** Compact author list for tree rows (1–2 names, else first + et al.). */
export function formatAuthorsShort(
	authors: string[] | undefined | null,
): string {
	if (!authors?.length) return "";
	const clean = authors.map((a) => a.trim()).filter(Boolean);
	if (clean.length === 0) return "";
	if (clean.length === 1) return clean[0] ?? "";
	if (clean.length === 2) return `${clean[0]}, ${clean[1]}`;
	return `${clean[0]} et al.`;
}

/**
 * Display label for a paper folder in the file tree.
 * Falls back to `folderName` when catalog metadata / title is missing.
 */
export function formatPaperTreeLabel(
	mode: PaperTreeLabelMode,
	meta: Pick<PaperMetadata, "title" | "authors" | "year"> | null | undefined,
	folderName: string,
): string {
	const folder = folderName.trim() || folderName;
	if (mode === "folder" || !meta) return folder;

	const title = (meta.title ?? "").trim();
	const authors = formatAuthorsShort(meta.authors);
	const year =
		typeof meta.year === "number" && Number.isFinite(meta.year)
			? String(meta.year)
			: "";

	if (mode === "title") {
		return title || folder;
	}

	if (mode === "title-author") {
		if (title && authors) return `${title} · ${authors}`;
		return title || authors || folder;
	}

	// author-year-title — e.g. "Vaswani et al. (2017) · Attention Is All You Need"
	const headParts: string[] = [];
	if (authors) headParts.push(authors);
	if (year) headParts.push(`(${year})`);
	const head = headParts.join(" ");
	if (head && title) return `${head} · ${title}`;
	return head || title || folder;
}
