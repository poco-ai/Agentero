/**
 * Reading order for PDF text runs inside one layout box.
 *
 * A bolder or larger word sticks up, so its top is higher than the words
 * beside it, while the bottoms still share a baseline. Group by that bottom,
 * left to right, then the next line down.
 */

export type ReadingBox = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type ReadingLine<T> = {
	items: T[];
	top: number;
	bottom: number;
};

function boxBottom(box: ReadingBox): number {
	return box.y + box.height;
}

/** Descenders and bold boxes shift the bottom by a fraction of the line, not a full line gap. */
function baselineTolerance(heightA: number, heightB: number): number {
	const positive = [heightA, heightB].filter((height) => height > 0);
	const height = positive.length
		? Math.min(...positive)
		: Math.max(heightA, heightB, 1);
	return Math.max(1.5, height * 0.45);
}

function medianSorted(values: readonly number[]): number {
	const mid = Math.floor(values.length / 2);
	if (values.length % 2 === 1) return values[mid] ?? 0;
	return ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
}

/** Insert into an ascending array. Median reads stay O(1) as a line grows. */
function insertSorted(values: number[], value: number): void {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((values[mid] ?? 0) <= value) low = mid + 1;
		else high = mid;
	}
	values.splice(low, 0, value);
}

export function groupReadingLines<T>(
	items: readonly T[],
	boxOf: (item: T) => ReadingBox,
): ReadingLine<T>[] {
	type Bucket = { items: T[]; bottoms: number[]; heights: number[] };
	const buckets: Bucket[] = [];
	const ordered = items.slice().sort((a, b) => {
		const left = boxOf(a);
		const right = boxOf(b);
		return boxBottom(left) - boxBottom(right) || left.x - right.x;
	});
	for (const item of ordered) {
		const box = boxOf(item);
		const bottom = boxBottom(box);
		let best: Bucket | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const bucket of buckets) {
			const distance = Math.abs(bottom - medianSorted(bucket.bottoms));
			const limit = baselineTolerance(box.height, medianSorted(bucket.heights));
			if (distance <= limit && distance < bestDistance) {
				best = bucket;
				bestDistance = distance;
			}
		}
		if (best) {
			best.items.push(item);
			insertSorted(best.bottoms, bottom);
			insertSorted(best.heights, box.height);
		} else {
			buckets.push({
				items: [item],
				bottoms: [bottom],
				heights: [box.height],
			});
		}
	}

	const lines = buckets.map((bucket) => {
		const lineItems = bucket.items
			.slice()
			.sort((a, b) => boxOf(a).x - boxOf(b).x || boxOf(a).y - boxOf(b).y);
		const boxes = lineItems.map(boxOf);
		return {
			items: lineItems,
			top: Math.min(...boxes.map((box) => box.y)),
			bottom: Math.max(...boxes.map(boxBottom)),
		};
	});
	lines.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
	return lines;
}

export function orderByReadingLine<T>(
	items: readonly T[],
	boxOf: (item: T) => ReadingBox,
): T[] {
	return groupReadingLines(items, boxOf).flatMap((line) => line.items);
}
