/**
 * Papers-library selection model: stable row keys, toggle / Shift-range
 * semantics, and marquee hit-testing. Pure — no React, no DOM — so the parts
 * that are easy to get wrong (range direction, pruning after a filter change,
 * rectangle matching) stay unit-testable.
 */
import type { PaperMetadata } from "@/lib/paper";

/** Row identity for selection: vault-relative path, catalog id as fallback. */
export function paperSelectionKey(
	paper: Pick<PaperMetadata, "path" | "id">,
): string {
	return paper.path || paper.id;
}

/** One row's vertical band in viewport pixels. */
export type RowBand = { key: string; top: number; bottom: number };

/**
 * Rows whose vertical band intersects `band`, in row order. A marquee selects
 * every row it touches (file-manager semantics), not only fully covered ones.
 */
export function keysIntersectingBand(
	bands: readonly RowBand[],
	band: { top: number; bottom: number },
): string[] {
	const top = Math.min(band.top, band.bottom);
	const bottom = Math.max(band.top, band.bottom);
	const keys: string[] = [];
	for (const row of bands) {
		if (row.bottom <= top || row.top >= bottom) continue;
		keys.push(row.key);
	}
	return keys;
}

/** Inclusive slice of `order` between anchor and key (the key alone if no anchor). */
export function rangeKeys(
	order: readonly string[],
	anchor: string | null,
	key: string,
): string[] {
	const to = order.indexOf(key);
	if (to < 0) return [key];
	const from = anchor ? order.indexOf(anchor) : -1;
	if (from < 0) return [key];
	const [lo, hi] = from <= to ? [from, to] : [to, from];
	return order.slice(lo, hi + 1);
}

export function toggleKey(prev: ReadonlySet<string>, key: string): Set<string> {
	const next = new Set(prev);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/**
 * Drop keys that are no longer visible (filter, scope or deletion) so a batch
 * action can never hit rows the user cannot see. Returns `prev` unchanged when
 * nothing was dropped, which keeps React from re-rendering.
 */
export function pruneKeys(
	prev: ReadonlySet<string>,
	order: readonly string[],
): ReadonlySet<string> {
	if (prev.size === 0) return prev;
	const visible = new Set(order);
	let dropped = false;
	const next = new Set<string>();
	for (const key of prev) {
		if (visible.has(key)) next.add(key);
		else dropped = true;
	}
	return dropped ? next : prev;
}

/** True when both sets hold exactly the same keys (including identity). */
export function sameKeys(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
): boolean {
	if (a === b) return true;
	if (a.size !== b.size) return false;
	for (const key of a) {
		if (!b.has(key)) return false;
	}
	return true;
}
