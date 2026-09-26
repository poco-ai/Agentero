import type { LibraryColumnPref } from "@/lib/settings";

export const MIN_COLUMN_WIDTH_REM = 5;
export const MAX_COLUMN_WIDTH_REM = 120;
export const clampColumnWidth = (width: number) =>
	Math.min(MAX_COLUMN_WIDTH_REM, Math.max(MIN_COLUMN_WIDTH_REM, width));

/** Explicit widths keep table-layout:fixed from redistributing saved widths. */
export function resolveColumnWidths(
	columns: LibraryColumnPref[],
	viewportRem: number,
	weight: (column: LibraryColumnPref) => number,
): number[] {
	const fixed = columns.reduce((sum, col) => sum + (col.widthRem ?? 0), 0);
	const adaptive = columns.filter((col) => col.widthRem === undefined);
	const available = Math.max(56.25, viewportRem) - fixed;
	const totalWeight = adaptive.reduce((sum, col) => sum + weight(col), 0);
	return columns.map(
		(col) =>
			col.widthRem ??
			Math.max(MIN_COLUMN_WIDTH_REM, (available * weight(col)) / totalWeight),
	);
}
