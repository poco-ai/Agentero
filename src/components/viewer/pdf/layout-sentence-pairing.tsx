/**
 * Shared sentence interaction and highlight for single and dual-pane PDFs.
 * Pointer moves update the shared hover record. Each mounted page paints its
 * own spans, so a sentence lights up when its page enters the buffer and
 * nothing here scrolls the partner pane.
 */

import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { EMBED_PAGE_ATTR } from "@/components/viewer/pdf/coords";
import { layoutElementActionStore } from "@/components/viewer/pdf/layout-element-action-store";
import {
	clearLayoutSentenceHover,
	heldLayoutSentenceDocument,
	type LayoutSentenceHover,
	layoutSentenceHover,
	layoutSentenceLineRects,
	releaseLayoutSentenceHover,
	sentenceForActivation,
	subscribeLayoutSentenceHover,
	suppressLayoutSentenceHover,
	syncLayoutSentencePointer,
} from "@/components/viewer/pdf/layout-sentence-hover";
import {
	LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX,
	layoutSentenceScope,
} from "@/lib/pdf/layout";
import { sourceSentenceHoverBands } from "@/lib/pdf/layout/element-sentence";
import { translatedSelectionLineRects } from "@/lib/pdf/layout/visible-selection-rects";
import { linkPreviewDragActive } from "@/lib/pdf/link-preview-drag";

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

/** Sentence hover stays active during reading and element selection. */
export function usePdfSentenceInteraction(
	docId: string,
	hostRef: RefObject<HTMLElement | null>,
	onSentenceDoubleClick?: (
		sentence: LayoutSentenceHover,
		event: MouseEvent,
	) => void,
): void {
	const doubleClickRef = useRef(onSentenceDoubleClick);
	doubleClickRef.current = onSentenceDoubleClick;
	useEffect(() => {
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
			if (
				selectionOwns(root, event, origin) ||
				root.hasAttribute("data-pdf-selecting") ||
				linkPreviewDragActive()
			) {
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
			if (
				!page ||
				!Number.isInteger(pageIndex) ||
				(event.target instanceof Element &&
					event.target.closest("[data-pdf-chrome], [data-selection-menu]"))
			) {
				clearLayoutSentenceHover();
				return;
			}
			const box = page.getBoundingClientRect();
			if (!box.width || !box.height) return;
			syncLayoutSentencePointer({
				docId,
				regionId: span?.itemId ?? "",
				pageIndex,
				x: (event.clientX - box.left) / box.width,
				y: (event.clientY - box.top) / box.height,
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

		const onDoubleClick = (event: MouseEvent) => {
			if (!doubleClickRef.current || !(event.target instanceof Element)) return;
			if (
				event.target.closest("[data-layout-item], [data-pdf-chrome], a, button")
			)
				return;
			const page = event.target.closest<HTMLElement>(`[${EMBED_PAGE_ATTR}]`);
			if (!page) return;
			const box = page.getBoundingClientRect();
			const pageIndex = Number(page.getAttribute(EMBED_PAGE_ATTR));
			if (!box.width || !box.height || !Number.isInteger(pageIndex)) return;
			const hit = sentenceForActivation({
				docId,
				regionId: "",
				pageIndex,
				x: (event.clientX - box.left) / box.width,
				y: (event.clientY - box.top) / box.height,
			});
			const sentence = layoutSentenceHover();
			if (!hit || !sentence) return;
			event.preventDefault();
			event.stopPropagation();
			doubleClickRef.current(sentence, event);
		};
		root.addEventListener("dblclick", onDoubleClick, true);
		root.addEventListener("pointermove", onMove, true);
		root.addEventListener("pointerdown", onDown);
		root.addEventListener("pointerleave", onLeave);
		return () => {
			root.removeEventListener("dblclick", onDoubleClick, true);
			root.removeEventListener("pointermove", onMove, true);
			root.removeEventListener("pointerdown", onDown);
			root.removeEventListener("pointerleave", onLeave);
			if (raf) cancelAnimationFrame(raf);
			const current = layoutSentenceHover();
			if (current?.docId === docId) clearLayoutSentenceHover();
		};
	}, [docId, hostRef]);
}

/**
 * Paints the hovered sentence on one translation page.
 * Mounting the page is what paints an off-screen sentence once it is visible.
 */
export function PdfSentenceHighlight({
	docId,
	pageIndex,
	source = false,
}: {
	docId: string;
	pageIndex: number;
	source?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const layer = ref.current;
		const shell = layer?.parentElement;
		if (!layer || !shell) return;
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		let revealFrame = 0;
		let pending: {
			key: string;
			content: DocumentFragment;
			opacity: string;
		} | null = null;
		let paintedKey: string | null = null;
		let fadingOut = false;

		const install = () => {
			const next = pending;
			pending = null;
			fadingOut = false;
			layer.replaceChildren();
			paintedKey = next?.key ?? null;
			if (!next) return;
			layer.style.setProperty("--pdf-sentence-opacity", next.opacity);
			layer.append(next.content);
			if (reducedMotion.matches) {
				layer.classList.add("is-on");
				return;
			}
			// Commit the hidden style before starting the shared opacity transition.
			void getComputedStyle(layer).opacity;
			revealFrame = requestAnimationFrame(() => {
				revealFrame = 0;
				layer.classList.add("is-on");
			});
		};
		const transition = (next: typeof pending) => {
			pending = next;
			if (revealFrame) cancelAnimationFrame(revealFrame);
			revealFrame = 0;
			if (reducedMotion.matches) {
				layer.classList.remove("is-on");
				install();
				return;
			}
			if (fadingOut) return;
			if (
				!layer.childElementCount ||
				Number(getComputedStyle(layer).opacity) === 0
			) {
				layer.classList.remove("is-on");
				install();
				return;
			}
			fadingOut = true;
			layer.classList.remove("is-on");
		};
		const onTransitionEnd = (event: TransitionEvent) => {
			if (
				event.target === layer &&
				event.propertyName === "opacity" &&
				fadingOut
			)
				install();
		};
		layer.addEventListener("transitionend", onTransitionEnd);
		const paint = () => {
			const action = layoutElementActionStore.getState().action;
			const current = action ? action.sentence : layoutSentenceHover();
			const mine =
				current &&
				layoutSentenceScope(current.docId) === layoutSentenceScope(docId)
					? current
					: null;
			const selectedDocument =
				action?.sentence?.docId ?? heldLayoutSentenceDocument();
			// The translated side keeps its native DOM selection tint; the source
			// PDF has no DOM text, so this layer owns its held sentence band.
			if (!mine || (!action && !source && selectedDocument === docId)) {
				transition(null);
				return;
			}
			const box = shell.getBoundingClientRect();
			if (!box.width || !box.height) return;
			const content = document.createDocumentFragment();
			const append = (x: number, y: number, w: number, h: number) => {
				const band = document.createElement("span");
				Object.assign(band.style, {
					left: `${x * 100}%`,
					top: `${y * 100}%`,
					width: `${w * 100}%`,
					height: `${h * 100}%`,
				});
				content.append(band);
			};
			if (source) {
				const lines = layoutSentenceLineRects(docId, pageIndex);
				for (const rect of sourceSentenceHoverBands(
					mine.members
						.filter((member) => member.pageIndex === pageIndex)
						.flatMap((member) => member.rects),
					box.width,
					box.height,
					lines.length ? lines : undefined,
				))
					append(rect.x, rect.y, rect.w, rect.h);
			} else {
				for (const member of mine.members) {
					if (member.pageIndex !== pageIndex) continue;
					for (const node of shell.querySelectorAll<HTMLElement>(
						`[data-layout-item="${CSS.escape(member.itemId)}"] [data-sentence="${member.sentenceIndex}"]`,
					)) {
						const range = document.createRange();
						range.selectNodeContents(node);
						for (const line of translatedSelectionLineRects(shell, range)) {
							append(
								(line.left - box.left) / box.width,
								(line.top - box.top) / box.height,
								line.width / box.width,
								line.height / box.height,
							);
						}
					}
				}
			}
			if (!content.childElementCount) {
				transition(null);
				return;
			}
			const next = {
				key: mine.key,
				content,
				opacity: selectedDocument ? "28%" : "12%",
			};
			if (paintedKey === mine.key && !fadingOut) {
				layer.replaceChildren(content);
				layer.style.setProperty("--pdf-sentence-opacity", next.opacity);
			} else transition(next);
		};
		const unsubscribe = subscribeLayoutSentenceHover(paint);
		const unsubscribeAction = layoutElementActionStore.subscribe(paint);
		const observer =
			typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
		observer?.observe(shell);
		paint();
		return () => {
			unsubscribe();
			unsubscribeAction();
			observer?.disconnect();
			if (revealFrame) cancelAnimationFrame(revealFrame);
			layer.removeEventListener("transitionend", onTransitionEnd);
		};
	}, [docId, pageIndex, source]);
	return (
		<div
			ref={ref}
			className="pdf-layout-sentence-wash"
			data-source-sentence={source || undefined}
			style={{ zIndex: source ? 6 : 4 }}
			aria-hidden="true"
		/>
	);
}
