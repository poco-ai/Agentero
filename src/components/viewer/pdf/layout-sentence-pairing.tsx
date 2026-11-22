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
	layoutSentenceCatalogItems,
	layoutSentenceHover,
	layoutSentenceLineRects,
	releaseLayoutSentenceHover,
	sentenceForActivation,
	subscribeLayoutSentenceHover,
	suppressLayoutSentenceHover,
	syncLayoutSentencePointer,
} from "@/components/viewer/pdf/layout-sentence-hover";
import { MOTION_MS, prefersReducedMotion } from "@/lib/core/motion";
import {
	LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX,
	layoutSentenceScope,
} from "@/lib/pdf/layout";
import {
	companionReflowSentenceBands,
	sourceSentenceHoverBands,
} from "@/lib/pdf/layout/element-sentence";
import {
	translatedSelectionLineRects,
	translatedSentenceAtPoint,
} from "@/lib/pdf/layout/visible-selection-rects";
import { linkPreviewDragActive } from "@/lib/pdf/link-preview-drag";
import { synctexHoverSupersedes } from "@/lib/tex/synctex-boxes";

/** Kept in sync with `--motion-duration-micro` in index.css. */
const SENTENCE_BAND_FADE_MS = MOTION_MS.micro;

function spanFromTarget(
	event: PointerEvent,
): { itemId: string; sentenceIndex: number } | null {
	const { target, clientX, clientY } = event;
	if (!(target instanceof Element)) return null;
	const span = translatedSentenceAtPoint(target, clientX, clientY);
	const index = span?.getAttribute("data-sentence");
	const itemId =
		span?.closest<HTMLElement>("[data-layout-item]")?.dataset.layoutItem;
	const sentenceIndex = Number(index);
	if (index == null || !itemId || !Number.isInteger(sentenceIndex)) return null;
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

/**
 * Sentence hover stays active during reading and element selection.
 * `enabled: false` turns off both the hover wash and the double-click sentence
 * selection; the writing preview keeps only its SyncTeX line hover.
 */
export function usePdfSentenceInteraction(
	docId: string,
	hostRef: RefObject<HTMLElement | null>,
	onSentenceDoubleClick?: (
		sentence: LayoutSentenceHover,
		event: MouseEvent,
	) => void,
	options?: { enabled?: boolean },
): void {
	const enabled = options?.enabled ?? true;
	const doubleClickRef = useRef(onSentenceDoubleClick);
	doubleClickRef.current = onSentenceDoubleClick;
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
			if (synctexHoverSupersedes(docId)) {
				clearLayoutSentenceHover();
				return;
			}
			if (
				selectionOwns(root, event, origin) ||
				root.hasAttribute("data-pdf-selecting") ||
				linkPreviewDragActive()
			) {
				suppressLayoutSentenceHover();
				return;
			}
			releaseLayoutSentenceHover();
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
			const span = spanFromTarget(event);
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
			if (synctexHoverSupersedes(docId)) return;
			if (!doubleClickRef.current || !(event.target instanceof Element)) return;
			// The layout-element action card is the active toolbar for the
			// element under the pointer. This same double-click must not also
			// open the sentence selection menu on top of it (#1175).
			const action = layoutElementActionStore.getState().action;
			if (
				action &&
				layoutSentenceScope(action.docId) === layoutSentenceScope(docId)
			)
				return;
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
	}, [docId, hostRef, enabled]);
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
		let paintedKey: string | null = null;
		let hideTimer = 0;
		const fadeTimers = new Set<number>();

		/** Bands of the current sentence; `is-leaving` ones are already fading. */
		const liveBands = () =>
			Array.from(layer.children).filter(
				(node): node is HTMLElement =>
					node instanceof HTMLElement && !node.classList.contains("is-leaving"),
			);

		/** Fade the previous sentence out under the new one, never delaying it. */
		const retireBands = (nodes: readonly HTMLElement[]) => {
			if (nodes.length > 0) {
				if (prefersReducedMotion()) {
					for (const node of nodes) node.remove();
				} else {
					for (const node of nodes) node.classList.add("is-leaving");
					const timer = window.setTimeout(() => {
						fadeTimers.delete(timer);
						for (const node of nodes) node.remove();
					}, SENTENCE_BAND_FADE_MS);
					fadeTimers.add(timer);
				}
			}
			window.clearTimeout(hideTimer);
			hideTimer = window.setTimeout(() => {
				hideTimer = 0;
				if (liveBands().length > 0) return;
				layer.classList.remove("is-on");
			}, SENTENCE_BAND_FADE_MS);
		};

		const clear = () => {
			if (paintedKey === null && !layer.classList.contains("is-on")) return;
			paintedKey = null;
			layer.classList.remove("is-held");
			retireBands(liveBands());
		};
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
				clear();
				return;
			}
			if (!mine.members.some((member) => member.pageIndex === pageIndex)) {
				clear();
				return;
			}
			const box = shell.getBoundingClientRect();
			if (!box.width || !box.height) return;
			const content = document.createDocumentFragment();
			const append = (
				x: number,
				y: number,
				w: number,
				h: number,
				sourceGeometry = false,
			) => {
				const band = document.createElement("span");
				band.className = "pdf-sentence-band";
				if (sourceGeometry) band.dataset.sourceGeometry = "";
				Object.assign(band.style, {
					left: `${x * 100}%`,
					top: `${y * 100}%`,
					width: `${w * 100}%`,
					height: `${h * 100}%`,
				});
				content.append(band);
			};
			const appendSourceBands = () => {
				const lines = layoutSentenceLineRects(docId, pageIndex);
				for (const rect of sourceSentenceHoverBands(
					mine.members
						.filter((member) => member.pageIndex === pageIndex)
						.flatMap((member) => member.rects),
					Math.round(box.width),
					Math.round(box.height),
					lines.length ? lines : undefined,
				))
					append(rect.x, rect.y, rect.w, rect.h, true);
			};
			if (source) {
				appendSourceBands();
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
				// Reflow not finished, or the block has no sentence spans: the
				// translation page is still the source PDF, or the placed
				// translation has no `[data-sentence]` node. Either way a cleared
				// layer is the bug — paint the placed translation, then the
				// source glyphs.
				if (!content.childElementCount) {
					const placed = companionReflowSentenceBands(
						layoutSentenceCatalogItems(docId),
						mine.members,
						pageIndex,
					);
					if (placed?.length) {
						for (const rect of placed) append(rect.x, rect.y, rect.w, rect.h);
					} else {
						appendSourceBands();
					}
				}
			}
			if (!content.childElementCount) {
				clear();
				return;
			}
			// Crossfade: the new sentence paints on the same frame under the
			// pointer, while the previous one fades out beneath it. Fading the old
			// one out *before* showing the next dropped every block the pointer
			// crossed during that fade.
			const sameSentence = paintedKey === mine.key;
			const previous = liveBands();
			if (sameSentence) {
				// Zoom / resize on the same sentence: replace without a fade.
				for (const node of previous) node.remove();
			} else {
				retireBands(previous);
			}
			window.clearTimeout(hideTimer);
			hideTimer = 0;
			paintedKey = mine.key;
			// A hovered sentence is a light wash, a pinned one a denser wash; the
			// weights live in index.css so no caller sets an opacity (see there).
			layer.classList.toggle("is-held", Boolean(selectedDocument));
			layer.append(content);
			layer.classList.add("is-on");
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
			window.clearTimeout(hideTimer);
			for (const timer of fadeTimers) window.clearTimeout(timer);
			layer.replaceChildren();
			layer.classList.remove("is-on", "is-held");
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
