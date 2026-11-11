import type { PdfLinkHoverPoint } from "@/components/viewer/pdf/types";
import { bracketCitationTokens } from "@/lib/pdf/link-text";

/** Locate a citation token using rendered character boxes, so proportional
 * fonts and wrapped links do not fall back to the whole annotation's centre. */
export function textLinkHoverPoint(
	element: HTMLElement,
	pointer?: { clientX: number; clientY: number },
	context?: { text: string; offset: number },
): PdfLinkHoverPoint {
	const box = element.getBoundingClientRect();
	const point: PdfLinkHoverPoint = {
		x: box.left + box.width / 2,
		y: box.bottom,
		top: box.top,
		bottom: box.bottom,
	};
	const length = element.textContent?.length ?? 0;
	const offset = context?.offset ?? 0;
	const tokens = bracketCitationTokens(
		context?.text ?? element.textContent ?? "",
	)
		.filter((token) => token.start < offset + length && token.end > offset)
		.map((token) => ({
			...token,
			start: Math.max(0, token.start - offset),
			end: Math.min(length, token.end - offset),
		}));
	if (!tokens.length) return point;
	let chosen = tokens[0];
	let closest = Infinity;
	if (pointer) {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const nodes: { node: Node; start: number; end: number }[] = [];
		let textOffset = 0;
		while (walker.nextNode()) {
			const node = walker.currentNode,
				end = textOffset + (node.textContent?.length ?? 0);
			nodes.push({ node, start: textOffset, end });
			textOffset = end;
		}
		for (const token of tokens) {
			const start = nodes.find(
				(n) => n.start <= token.start && n.end > token.start,
			);
			const end = nodes.find((n) => n.start < token.end && n.end >= token.end);
			if (!start || !end) continue;
			const range = document.createRange();
			range.setStart(start.node, token.start - start.start);
			range.setEnd(end.node, token.end - end.start);
			for (const rect of range.getClientRects()) {
				const dx = Math.max(
					rect.left - pointer.clientX,
					pointer.clientX - rect.right,
					0,
				);
				const dy = Math.max(
					rect.top - pointer.clientY,
					pointer.clientY - rect.bottom,
					0,
				);
				const distance = dx * dx + dy * dy;
				if (distance < closest) {
					chosen = token;
					closest = distance;
				}
			}
		}
	}
	point.citation = chosen.citation;
	return point;
}
