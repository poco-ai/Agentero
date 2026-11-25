import { type RefObject, useEffect } from "react";
import { EMBED_PAGE_ATTR } from "@/components/viewer/pdf/coords";
import { clearDomSelectionInside } from "@/components/viewer/pdf/host-dom";
import {
	clearTranslationSelectionBands,
	publishTranslationSelectionBands,
} from "@/lib/pdf/layout/translation-selection-bands";
import {
	type PageFrame,
	translatedSelectionLineRects,
	visiblePagesFromClientRects,
} from "@/lib/pdf/layout/visible-selection-rects";

export function translationPageFrames(host: HTMLElement): PageFrame[] {
	return Array.from(
		host.querySelectorAll<HTMLElement>(`[${EMBED_PAGE_ATTR}]`),
	).flatMap((element) => {
		const pageIndex = Number(element.getAttribute(EMBED_PAGE_ATTR));
		const box = element.getBoundingClientRect();
		return Number.isInteger(pageIndex) && box.width > 0 && box.height > 0
			? [
					{
						pageIndex,
						left: box.left,
						top: box.top,
						width: box.width,
						height: box.height,
					},
				]
			: [];
	});
}

export type ClippedTranslationRange = { range: Range; parts: Range[] };

export function clippedPartsFor(
	range: Range,
	clipped: ClippedTranslationRange | null,
): Range[] | undefined {
	if (
		clipped &&
		range.compareBoundaryPoints(Range.START_TO_START, clipped.range) === 0 &&
		range.compareBoundaryPoints(Range.END_TO_END, clipped.range) === 0
	) {
		return clipped.parts;
	}
}

/** Native translated text uses the same line bands in both viewer modes. */
export function useTranslationSelectionBands(
	docId: string,
	hostRef: RefObject<HTMLElement | null>,
	enabled: boolean,
	clippedRef: RefObject<ClippedTranslationRange | null>,
): void {
	useEffect(() => {
		if (!enabled) {
			clearTranslationSelectionBands(docId);
			return;
		}
		const host = hostRef.current;
		if (!host) return;
		let visible = true;
		let frame = 0;
		const paint = () => {
			frame = 0;
			if (!visible) return;
			const selection = window.getSelection();
			const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
			const inside = (node: Node) => {
				const element = node instanceof Element ? node : node.parentElement;
				return (
					element &&
					host.contains(element) &&
					element.closest("[data-layout-item]")
				);
			};
			if (
				!range ||
				selection?.isCollapsed ||
				(!inside(range.startContainer) && !inside(range.endContainer))
			) {
				clearTranslationSelectionBands(docId);
				return;
			}
			const parts = clippedPartsFor(range, clippedRef.current) ?? [range];
			publishTranslationSelectionBands(
				docId,
				visiblePagesFromClientRects(
					parts.flatMap((part) => translatedSelectionLineRects(host, part)),
					translationPageFrames(host),
				),
			);
		};
		const schedule = () => {
			if (visible && !frame) frame = requestAnimationFrame(paint);
		};
		const observer =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver((entries) => {
						visible = entries.some((entry) => entry.isIntersecting);
						if (visible) {
							schedule();
							return;
						}
						if (frame) cancelAnimationFrame(frame);
						frame = 0;
						clearTranslationSelectionBands(docId);
						clearDomSelectionInside(host);
					});
		observer?.observe(host);
		document.addEventListener("selectionchange", schedule);
		document.addEventListener("pointerup", schedule, true);
		return () => {
			observer?.disconnect();
			if (frame) cancelAnimationFrame(frame);
			document.removeEventListener("selectionchange", schedule);
			document.removeEventListener("pointerup", schedule, true);
			clearTranslationSelectionBands(docId);
		};
	}, [docId, hostRef, enabled, clippedRef]);
}
