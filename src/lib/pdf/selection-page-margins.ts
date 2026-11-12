import type { PdfTextRectObject, Rect, Size } from "@embedpdf/models";
import { groupReadingLines } from "@/lib/pdf/layout/reading-order";

export type SelectionMarginCandidate = {
	edge: "header" | "footer" | "page-number";
	text: string;
	y: number;
	rect: Rect;
};

function textKey(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");
}

function isPageNumber(text: string): boolean {
	const value = text
		.normalize("NFKC")
		.trim()
		.replace(/^[–—-]\s*|\s*[–—-]$/gu, "")
		.replace(/^\((.+)\)$/u, "$1")
		.trim();
	return (
		/^(?:(?:page|p\.)\s*)?(?:[SA][-\s]?)?\d{1,5}(?:\s*(?:\/|of)\s*\d{1,5})?$/iu.test(
			value,
		) ||
		/^(?=[mdclxvi]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/iu.test(
			value,
		) ||
		/^第?\s*\d{1,5}\s*页(?:\s*[,，/]?\s*共\s*\d{1,5}\s*页)?$/u.test(value)
	);
}

/** Running headers, repeated footers and page numbers stay inside page margins. */
export function selectionMarginCandidates(
	rects: readonly PdfTextRectObject[],
	size: Size,
): SelectionMarginCandidate[] {
	if (size.height <= 0) return [];
	return groupReadingLines(
		rects.filter(
			({ content, rect }) =>
				Boolean(content?.trim()) &&
				rect.origin.y >= 0 &&
				((rect.origin.y + rect.size.height) / size.height <= 0.12 ||
					rect.origin.y / size.height >= 0.88),
		),
		({ rect }) => ({
			x: rect.origin.x,
			y: rect.origin.y,
			width: rect.size.width,
			height: rect.size.height,
		}),
	).flatMap((line) => {
		if ((line.bottom - line.top) / size.height > 0.03) return [];
		const content = line.items
			.map(({ content }) => content)
			.join(" ")
			.trim();
		const footer = line.top / size.height >= 0.88;
		const text = textKey(content);
		const pageNumber = isPageNumber(content);
		if (!pageNumber && text.length < 8) return [];
		const left = Math.min(...line.items.map(({ rect }) => rect.origin.x));
		const right = Math.max(
			...line.items.map(({ rect }) => rect.origin.x + rect.size.width),
		);
		// At the top, page numbers are short and centred/right-aligned; a
		// left-aligned section number must keep its place in the body.
		if (
			!footer &&
			pageNumber &&
			((left + right) / 2 < size.width * 0.35 ||
				right - left > size.width * 0.25)
		)
			return [];
		return [
			{
				edge: pageNumber
					? ("page-number" as const)
					: footer
						? ("footer" as const)
						: ("header" as const),
				text,
				y: line.top / size.height,
				rect: {
					origin: { x: left, y: line.top },
					size: { width: right - left, height: line.bottom - line.top },
				},
			},
		];
	});
}

/** Preserve the paper's first-page title and headings inside the body. */
export function selectionPageMargins(
	pages: ReadonlyMap<number, readonly SelectionMarginCandidate[]>,
	paperTitle?: string,
): ReadonlyMap<number, readonly Rect[]> {
	const title = textKey(paperTitle ?? "");
	const result = new Map<number, Rect[]>();
	for (const [page, candidates] of pages) {
		const headers = candidates.filter(
			(candidate) =>
				candidate.edge === "page-number" ||
				((candidate.edge === "footer" || page > 0) &&
					((candidate.edge === "header" && candidate.text === title) ||
						[...pages].some(
							([otherPage, other]) =>
								otherPage !== page &&
								other.some(
									(match) =>
										match.edge === candidate.edge &&
										match.text === candidate.text &&
										Math.abs(match.y - candidate.y) < 0.02,
								),
						))),
		);
		if (headers.length)
			result.set(
				page,
				headers.map(({ rect }) => rect),
			);
	}
	return result;
}
