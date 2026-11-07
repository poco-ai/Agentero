/**
 * How many leading toolbar actions fit on one row.
 *
 * `available` must be the toolbar's own inner width minus the pinned trailing
 * cluster — never the width of the row that the returned count feeds into
 * (e.g. the flex-1 action container). A count derived from the layout it
 * produces re-triggers the ResizeObserver that produced it, so the buttons
 * collapse and expand forever while the pointer sits still
 * (see `docs/development/resize-performance-research.md` §1.14).
 *
 * Room for the overflow trigger is reserved only when something is actually
 * hidden, so a toolbar that fits everything keeps the full width.
 */
export function fitToolbarActions(
	widths: readonly number[],
	available: number,
	overflowWidth: number,
): number {
	let total = 0;
	for (const width of widths) total += width;
	if (total <= available) return widths.length;

	const budget = available - overflowWidth;
	let used = 0;
	let count = 0;
	for (const width of widths) {
		if (used + width > budget) break;
		used += width;
		count += 1;
	}
	return count;
}
