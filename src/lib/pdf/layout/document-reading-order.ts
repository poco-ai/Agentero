import type { DocumentAnchorRegion } from "./types";

type Box = NonNullable<DocumentAnchorRegion["bbox"]>;
type BoxedRegion = DocumentAnchorRegion & { bbox: Box };

function storedOrder(a: DocumentAnchorRegion, b: DocumentAnchorRegion): number {
	return (
		(a.readingOrder ?? Number.MAX_SAFE_INTEGER) -
			(b.readingOrder ?? Number.MAX_SAFE_INTEGER) ||
		(a.bbox?.y ?? 0) - (b.bbox?.y ?? 0) ||
		(a.bbox?.x ?? 0) - (b.bbox?.x ?? 0) ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

function hasBox(region: DocumentAnchorRegion): region is BoxedRegion {
	const box = region.bbox;
	return (
		!!box &&
		[box.x, box.y, box.w, box.h].every(Number.isFinite) &&
		box.w > 0 &&
		box.h > 0
	);
}

/**
 * Remote layout producers can store y-only readingOrder, interleaving columns.
 * Infer a gutter from disjoint body-text x intervals, with text on both sides
 * overlapping vertically. Short headings alone must not turn a single column
 * into two columns. Full-width blocks delimit horizontal bands.
 * Keep this in sync with core's document_reading_order.rs.
 */
function pageReadingOrder(
	page: DocumentAnchorRegion[],
): DocumentAnchorRegion[] {
	if (!page.every(hasBox)) return page;
	const body = page.filter(
		(r) =>
			(r.kind === "text" || r.kind === "paragraph") &&
			r.text?.trim() &&
			r.bbox.w <= 0.6,
	);
	let gutter: number | undefined;
	let gap = 0;
	let support = 0;
	// A centered author block above the columns must not bridge their gutter.
	// Infer intervals only among blocks that coexist at a physical page height.
	for (const row of body) {
		const intervals: { start: number; end: number }[] = [];
		for (const region of body
			.filter(
				(b) =>
					Math.min(row.bbox.y + row.bbox.h, b.bbox.y + b.bbox.h) >
					Math.max(row.bbox.y, b.bbox.y),
			)
			.sort((a, b) => a.bbox.x - b.bbox.x)) {
			const box = region.bbox;
			const last = intervals.at(-1);
			if (last && box.x - last.end < 0.002)
				last.end = Math.max(last.end, box.x + box.w);
			else intervals.push({ start: box.x, end: box.x + box.w });
		}
		for (let i = 1; i < intervals.length; i += 1) {
			const left = intervals[i - 1];
			const right = intervals[i];
			if (!left || !right) continue;
			const mid = (left.end + right.start) / 2;
			const before = body.filter((r) => r.bbox.x + r.bbox.w <= mid);
			const after = body.filter((r) => r.bbox.x >= mid);
			const count = before.length + after.length;
			if (
				count < support ||
				(count === support && right.start - left.end <= gap)
			)
				continue;
			if (
				!before.some((a) =>
					after.some(
						(b) =>
							Math.min(a.bbox.y + a.bbox.h, b.bbox.y + b.bbox.h) >
							Math.max(a.bbox.y, b.bbox.y),
					),
				)
			)
				continue;
			gutter = mid;
			gap = right.start - left.end;
			support = count;
		}
	}
	if (gutter === undefined) return page;
	const mid = gutter;
	const spans = page
		.filter((r) => r.bbox.x < mid && r.bbox.x + r.bbox.w > mid)
		.sort((a, b) => a.bbox.y - b.bbox.y || storedOrder(a, b));
	let remaining = page.filter((r) => !spans.includes(r));
	const ordered: DocumentAnchorRegion[] = [];
	const appendColumns = (items: BoxedRegion[]) =>
		ordered.push(
			...items.sort(
				(a, b) =>
					Number(a.bbox.x >= mid) - Number(b.bbox.x >= mid) ||
					a.bbox.y - b.bbox.y ||
					storedOrder(a, b),
			),
		);
	for (const span of spans) {
		appendColumns(remaining.filter((r) => r.bbox.y < span.bbox.y));
		remaining = remaining.filter((r) => r.bbox.y >= span.bbox.y);
		ordered.push(span);
	}
	appendColumns(remaining);
	return ordered;
}

export function documentReadingOrder(
	regions: readonly DocumentAnchorRegion[],
): DocumentAnchorRegion[] {
	const sorted = [...regions].sort(
		(a, b) => a.pageIndex - b.pageIndex || storedOrder(a, b),
	);
	const pages = new Map<number, DocumentAnchorRegion[]>();
	for (const region of sorted) {
		const page = pages.get(region.pageIndex) ?? [];
		page.push(region);
		pages.set(region.pageIndex, page);
	}
	return [...pages.values()].flatMap(pageReadingOrder);
}
