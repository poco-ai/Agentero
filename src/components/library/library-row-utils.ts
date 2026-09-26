/**
 * Pure row/column helpers for the papers library table: precomputed sort
 * keys, comparator, column order/visibility edits, and the cell-renderer
 * context types shared by COLUMN_META and the row component. No React state.
 */
import type { ReactNode } from "react";
import type { PaperLibraryRow, PaperMetadata } from "@/lib/paper";
import { publicationDateSortKey } from "@/lib/paper/publication-date";
import type { ReadingHeatmap } from "@/lib/paper/reading-heatmap";
import { type PaperTag, visiblePaperTags } from "@/lib/paper/tags";
import type { LibraryColumnKey, LibraryColumnPref } from "@/lib/settings";

export type SortKey = LibraryColumnKey;
export type SortDir = "asc" | "desc";

/** Full author list for clipboard (not the abbreviated display form). */
export function authorsCopyText(authors: string[] | undefined): string | null {
	if (!authors?.length) return null;
	return authors.join(", ");
}

/** Identifier for display / copy / sort — null when nothing usable. */
export function identifierValue(p: PaperMetadata): string | null {
	if (p.arxiv_id) return p.arxiv_id;
	if (p.doi) return p.doi;
	if (p.pmid) return `PMID:${p.pmid}`;
	return p.id || null;
}

/**
 * Only a real probe result counts: `has_pdf` is `undefined` for remote
 * listings, which nothing checked for a local PDF.
 */
export function isMissingLocalPdf(p: PaperLibraryRow): boolean {
	return p.has_pdf === false;
}

/** Catalog timestamps include a timezone; invalid legacy values stay empty. */
export function addedDate(value: string | undefined): Date | null {
	const timestamp = value?.trim() ? Date.parse(value) : Number.NaN;
	return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

/** Precomputed per-paper keys so sort/filter avoid O(n log n) re-coerce. */
export type PaperRow = {
	paper: PaperLibraryRow;
	tags: PaperTag[];
	searchText: string;
	tagSearch: string;
	sort: Record<SortKey, string | number>;
};

export function buildPaperRow(p: PaperLibraryRow): PaperRow {
	const tags = visiblePaperTags(p.tags);
	const id = identifierValue(p) ?? "";
	const tagSearch = tags
		.map((t) => t.name)
		.join(" ")
		.toLocaleLowerCase();
	return {
		paper: p,
		tags,
		tagSearch,
		searchText: [
			p.title,
			p.id,
			id,
			p.path,
			p.doi,
			p.arxiv_id,
			p.pmid ? `PMID:${p.pmid}` : null,
			p.isbn,
			p.publication,
			p.publisher,
			...(p.authors ?? []),
			tagSearch,
		]
			.filter((value): value is string => Boolean(value?.trim()))
			.join(" ")
			.toLocaleLowerCase(),
		sort: {
			title: (p.title ?? "").toLocaleLowerCase(),
			authors: (p.authors?.[0] ?? "").toLocaleLowerCase(),
			date: publicationDateSortKey(p) ?? Number.NEGATIVE_INFINITY,
			addedAt: addedDate(p.added_at)?.getTime() ?? Number.NEGATIVE_INFINITY,
			publication: (p.publication ?? "").toLocaleLowerCase(),
			id: id.toLocaleLowerCase(),
			tags: tags
				.map((t) => t.name)
				.join(", ")
				.toLocaleLowerCase(),
			citations: p.citation_count ?? Number.NEGATIVE_INFINITY,
		},
	};
}

export function comparePaperRows(
	a: PaperRow,
	b: PaperRow,
	key: SortKey,
	dir: SortDir,
): number {
	const av = a.sort[key];
	const bv = b.sort[key];
	let cmp = 0;
	if (typeof av === "number" && typeof bv === "number") {
		// Equal missing values (-Infinity) must still use the stable tie-break.
		cmp = av === bv ? 0 : av - bv;
	} else {
		cmp = String(av).localeCompare(String(bv), undefined, {
			numeric: true,
			sensitivity: "base",
		});
	}
	if (cmp === 0) {
		// Stable secondary: title then id
		cmp = (a.paper.title ?? "").localeCompare(b.paper.title ?? "", undefined, {
			sensitivity: "base",
		});
		if (cmp === 0) cmp = (a.paper.id ?? "").localeCompare(b.paper.id ?? "");
	}
	return dir === "asc" ? cmp : -cmp;
}

/** Move `fromKey` to sit just before `toKey` in the full column list. */
export function reorderColumns(
	cols: LibraryColumnPref[],
	fromKey: SortKey,
	toKey: SortKey,
): LibraryColumnPref[] {
	if (fromKey === toKey) return cols;
	const arr = [...cols];
	const fromIdx = arr.findIndex((c) => c.key === fromKey);
	if (fromIdx < 0) return cols;
	const [moved] = arr.splice(fromIdx, 1);
	const toIdx = arr.findIndex((c) => c.key === toKey);
	if (toIdx < 0) return cols;
	arr.splice(toIdx, 0, moved);
	return arr;
}

/** Toggle a column's visibility (title is kept visible by the caller). */
export function toggleColumnVisibility(
	cols: LibraryColumnPref[],
	key: SortKey,
): LibraryColumnPref[] {
	return cols.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c));
}

/** Narrow i18n helper for column renderers (avoids strict TFunction key unions). */
export type CellT = (key: string, options?: Record<string, unknown>) => string;

export type CellCtx = {
	t: CellT;
	onCellCopy: (text: string | null | undefined, label: string) => void;
	heat: ReadingHeatmap | undefined;
	tags: PaperTag[];
};

export type ColumnDef = {
	labelKey: string;
	widthWeight: number;
	headerClassName: string;
	render: (p: PaperLibraryRow, ctx: CellCtx) => ReactNode;
};
