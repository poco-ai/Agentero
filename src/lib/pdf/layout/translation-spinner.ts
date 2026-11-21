import { LAYOUT_SIDEBAR_MIN_SCORE } from "@/lib/pdf/layout/constants";
import {
	isFigureLayoutKind,
	isLayoutTranslatableKind,
} from "@/lib/pdf/layout/labels";
import { bboxCoveredBy } from "@/lib/pdf/layout/merge-captions";
import type { GlyphRun } from "@/lib/pdf/layout/translated-links";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";

export const TRANSLATION_SPINNER_SIZE = 12;

/** Paragraph fragments that are all translated and still wait for the page raster. */
function awaitingPagePreview(group: readonly LayoutTranslateItem[]): boolean {
	return (
		group.every((item) => !item.reflowPreview) &&
		group.some(
			(item) =>
				item.status === "done" &&
				Boolean(item.translated?.trim()) &&
				item.reflow,
		) &&
		group.every(
			(item) => item.status === "done" && Boolean(item.translated?.trim()),
		)
	);
}

/**
 * Group block items by their detected paragraph, including supplemental text
 * fragments. Items covered by a figure are dropped so the overlays never draw
 * status icons on top of artwork.
 */
export function translationParagraphGroups(
	items: readonly LayoutTranslateItem[],
	regions: readonly PdfLayoutRegion[],
): LayoutTranslateItem[][] {
	const figures = regions.filter(
		(region) =>
			isFigureLayoutKind(region.kind) &&
			region.score >= LAYOUT_SIDEBAR_MIN_SCORE,
	);
	const paragraphs = regions.filter((region) =>
		isLayoutTranslatableKind(region.kind),
	);
	const groups = new Map<string, LayoutTranslateItem[]>();
	for (const item of items) {
		// Suppress visual noise over figures without changing translation eligibility.
		if (
			figures.some(
				(figure) =>
					figure.pageIndex === item.pageIndex &&
					bboxCoveredBy(item.bbox, figure.bbox) >= 0.45,
			)
		)
			continue;
		const owner =
			paragraphs.find((region) => region.id === item.id) ??
			paragraphs
				.filter(
					(region) =>
						region.pageIndex === item.pageIndex &&
						bboxCoveredBy(item.bbox, region.bbox) >= 0.45,
				)
				.sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];
		const key = owner?.id ?? item.id;
		const group = groups.get(key) ?? [];
		group.push(item);
		groups.set(key, group);
	}
	return [...groups.values()];
}

/**
 * One status per detected paragraph, including any supplemental text fragments.
 *
 * `awaitingPreview` keeps the spinner on a finished paragraph until its page's
 * translated raster covers the source text. Callers only set it while that
 * preview is genuinely in flight: a cancelled run or a failed final build must
 * fall back to block status alone.
 */
export function translationSpinnerItems(
	items: readonly LayoutTranslateItem[],
	regions: readonly PdfLayoutRegion[] = [],
	awaitingPreview = false,
): readonly LayoutTranslateItem[] {
	return translationParagraphGroups(items, regions)
		.filter(
			(group) =>
				group.some((item) => item.status === "running") ||
				(awaitingPreview && awaitingPagePreview(group)),
		)
		.flatMap((group) =>
			group
				.sort(
					(a, b) =>
						a.bbox.y + a.bbox.h - (b.bbox.y + b.bbox.h) || a.bbox.x - b.bbox.x,
				)
				.slice(-1),
		);
}

/** Tail of the text actually visible in a reflow preview, or of the source. */
export function translationSpinnerAnchor(
	item: LayoutTranslateItem,
	width: number,
	height: number,
	runs: readonly GlyphRun[] = [],
): { x: number; y: number; size: number } {
	const paragraph = item.reflow;
	const sx = paragraph ? (width * item.bbox.w) / paragraph.box.w : 1;
	const sy = paragraph ? (height * item.bbox.h) / paragraph.box.h : 1;
	const unit = item.reflowLayout?.units.filter((u) => u.text.trim()).at(-1);
	if (unit) {
		const size = TRANSLATION_SPINNER_SIZE;
		return {
			x: (unit.x + unit.width) * sx + size * 0.2,
			y:
				(unit.y - (unit.formula ? unit.height : unit.fontSize * 0.8)) * sy +
				(unit.fontSize * sy - size) / 2,
			size,
		};
	}
	const character = paragraph?.characters.filter((c) => c.text.trim()).at(-1);
	if (character) {
		const size = TRANSLATION_SPINNER_SIZE;
		return {
			x: (character.box.x + character.box.w) * sx + size * 0.2,
			y: (character.box.y + character.box.h / 2) * sy - size / 2,
			size,
		};
	}
	const inBlock = runs.filter(
		({ text, box }) =>
			text.trim() &&
			box.x + box.w / 2 >= item.bbox.x &&
			box.x + box.w / 2 <= item.bbox.x + item.bbox.w &&
			box.y + box.h / 2 >= item.bbox.y &&
			box.y + box.h / 2 <= item.bbox.y + item.bbox.h,
	);
	// Runs follow the PDF text extraction order, including the final short line.
	const last = inBlock.at(-1)?.box;
	const size = TRANSLATION_SPINNER_SIZE;
	return {
		x: last
			? (last.x + last.w) * width + size * 0.2
			: (item.bbox.x + item.bbox.w) * width + size * 0.2,
		y: last
			? (last.y + last.h / 2) * height - size / 2
			: (item.bbox.y + item.bbox.h) * height - size,
		size,
	};
}
