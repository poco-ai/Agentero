/**
 * One highlight rectangle per line for a translation drag.
 *
 * English selection already unions a line into a single box under the glyphs.
 * Publishing the same shape here lets the page paint that box once, instead of
 * a translucent quad per Chinese character.
 */

import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import type { VisibleSelectionPage } from "@/lib/pdf/layout/visible-selection-rects";

const EMPTY_RECTS: readonly PdfAskNormalizedRect[] = [];

let pages: readonly VisibleSelectionPage[] = [];
const listeners = new Set<() => void>();

function samePages(
	left: readonly VisibleSelectionPage[],
	right: readonly VisibleSelectionPage[],
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (!a || !b || a.pageIndex !== b.pageIndex) return false;
		if (a.rects.length !== b.rects.length) return false;
		for (let rectIndex = 0; rectIndex < a.rects.length; rectIndex += 1) {
			const ar = a.rects[rectIndex];
			const br = b.rects[rectIndex];
			if (
				!ar ||
				!br ||
				ar.x !== br.x ||
				ar.y !== br.y ||
				ar.w !== br.w ||
				ar.h !== br.h
			) {
				return false;
			}
		}
	}
	return true;
}

function emit(): void {
	for (const listener of listeners) listener();
}

export function publishTranslationSelectionBands(
	next: readonly VisibleSelectionPage[],
): void {
	if (samePages(pages, next)) return;
	pages = next;
	emit();
}

export function clearTranslationSelectionBands(): void {
	publishTranslationSelectionBands([]);
}

export function translationSelectionBandsFor(
	pageIndex: number,
): readonly PdfAskNormalizedRect[] {
	return (
		pages.find((page) => page.pageIndex === pageIndex)?.rects ?? EMPTY_RECTS
	);
}

export function subscribeTranslationSelectionBands(
	listener: () => void,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
