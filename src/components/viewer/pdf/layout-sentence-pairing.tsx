/**
 * Dual-pane sentence wash on the translation companion.
 * Pointer moves update the shared hover record. Each mounted page paints its
 * own spans, so a sentence lights up when its page enters the buffer and
 * nothing here scrolls the partner pane.
 */

import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { EMBED_PAGE_ATTR } from "@/components/viewer/pdf/coords";
import {
	clearLayoutSentenceHover,
	layoutSentenceHover,
	releaseLayoutSentenceHover,
	subscribeLayoutSentenceHover,
	suppressLayoutSentenceHover,
	syncLayoutSentencePointer,
} from "@/components/viewer/pdf/layout-sentence-hover";
import {
	LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX,
	layoutSentenceScope,
} from "@/lib/pdf/layout";

function spanFromTarget(
	target: EventTarget | null,
): { itemId: string; sentenceIndex: number } | null {
	if (!(target instanceof Element)) return null;
	const span = target.closest("[data-sentence]");
	const item = span?.closest("[data-layout-item]");
	if (!span || !item) return null;
	const itemId = item.getAttribute("data-layout-item");
	const sentenceIndex = Number(span.getAttribute("data-sentence"));
	if (!itemId || !Number.isInteger(sentenceIndex)) return null;
	return { itemId, sentenceIndex };
}

function selectionOwns(
	root: HTMLElement,
	event: PointerEvent,
	origin: {
		x: number;
		y: number;
	} | null,
): boolean {
	const selected = document.getSelection();
	if (
		selected &&
		!selected.isCollapsed &&
		selected.toString().trim() &&
		selected.anchorNode &&
		root.contains(selected.anchorNode)
	) {
		return true;
	}
	if (event.buttons !== 1 || !origin) return false;
	const dx = event.clientX - origin.x;
	const dy = event.clientY - origin.y;
	const limit = LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX;
	return dx * dx + dy * dy > limit * limit;
}

/** Host listener. Does not paint and does not scroll. */
export function useLayoutSentencePairing(
	docId: string,
	hostRef: RefObject<HTMLElement | null>,
	enabled: boolean,
): void {
	useEffect(() => {
		if (!enabled) return;
		const root = hostRef.current;
		if (!root) return;
		let origin: { x: number; y: number } | null = null;
		let raf = 0;
		let pending: PointerEvent | null = null;

		const apply = () => {
			raf = 0;
			const event = pending;
			pending = null;
			if (!event) return;
			if (selectionOwns(root, event, origin)) {
				suppressLayoutSentenceHover();
				return;
			}
			releaseLayoutSentenceHover();
			const span = spanFromTarget(event.target);
			const page =
				event.target instanceof Element
					? event.target.closest<HTMLElement>(`[${EMBED_PAGE_ATTR}]`)
					: null;
			const pageIndex = Number(page?.getAttribute(EMBED_PAGE_ATTR));
			if (!span || !page || !Number.isInteger(pageIndex)) {
				clearLayoutSentenceHover();
				return;
			}
			syncLayoutSentencePointer({
				docId,
				regionId: span.itemId,
				pageIndex,
				x: 0,
				y: 0,
				span,
			});
		};

		const onMove = (event: PointerEvent) => {
			pending = event;
			if (raf) return;
			raf = requestAnimationFrame(apply);
		};
		const onDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			origin = { x: event.clientX, y: event.clientY };
		};
		const onLeave = () => {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
			pending = null;
			clearLayoutSentenceHover();
		};

		root.addEventListener("pointermove", onMove);
		root.addEventListener("pointerdown", onDown);
		root.addEventListener("pointerleave", onLeave);
		return () => {
			root.removeEventListener("pointermove", onMove);
			root.removeEventListener("pointerdown", onDown);
			root.removeEventListener("pointerleave", onLeave);
			if (raf) cancelAnimationFrame(raf);
			const current = layoutSentenceHover();
			if (current?.docId === docId) clearLayoutSentenceHover();
		};
	}, [docId, enabled, hostRef]);
}

/**
 * Marks the hovered sentence's spans on one translation page.
 * Mounting the page is what paints an off-screen sentence once it is visible.
 */
export function LayoutSentencePageMark({
	docId,
	pageIndex,
}: {
	docId: string;
	pageIndex: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const shell = ref.current?.parentElement;
		if (!shell) return;
		const marked: HTMLElement[] = [];
		const paint = () => {
			const current = layoutSentenceHover();
			const mine =
				current &&
				layoutSentenceScope(current.docId) === layoutSentenceScope(docId)
					? current
					: null;
			for (const node of marked) node.removeAttribute("data-sentence-hot");
			marked.length = 0;
			if (!mine) return;
			for (const member of mine.members) {
				if (member.pageIndex !== pageIndex) continue;
				const nodes = shell.querySelectorAll<HTMLElement>(
					`[data-layout-item="${CSS.escape(member.itemId)}"] [data-sentence="${member.sentenceIndex}"]`,
				);
				for (const node of nodes) {
					node.setAttribute("data-sentence-hot", "1");
					marked.push(node);
				}
			}
		};
		const unsubscribe = subscribeLayoutSentenceHover(paint);
		paint();
		return () => {
			unsubscribe();
			for (const node of marked) node.removeAttribute("data-sentence-hot");
		};
	}, [docId, pageIndex]);
	return <div ref={ref} className="contents" />;
}
