/**
 * Shared sentence interaction and highlight for single and dual-pane PDFs.
 * Pointer moves update the shared hover record. Each mounted page paints its
 * own spans, so a sentence lights up when its page enters the buffer and
 * nothing here scrolls the partner pane.
 */

import {
	Fragment,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { EMBED_PAGE_ATTR } from "@/components/viewer/pdf/coords";
import { layoutElementActionStore } from "@/components/viewer/pdf/layout-element-action-store";
import {
	clearLayoutSentenceHover,
	heldLayoutSentenceDocument,
	type LayoutSentenceHover,
	layoutSentenceCatalogItems,
	layoutSentenceHover,
	layoutSentenceLineRects,
	layoutSentencePointerHover,
	releaseHeldLayoutSentenceHover,
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
import {
	companionReflowSentenceBands,
	type SentenceFractionRect,
	sentenceOutlinePath,
	sourceSentenceHoverBands,
} from "@/lib/pdf/layout/element-sentence";
import {
	translatedSelectionLineRects,
	translatedSentenceAtPoint,
} from "@/lib/pdf/layout/visible-selection-rects";
import { linkPreviewDragActive } from "@/lib/pdf/link-preview-drag";
import { synctexHoverSupersedes } from "@/lib/tex/synctex-boxes";

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
			const page =
				event.target instanceof Element
					? event.target.closest<HTMLElement>(`[${EMBED_PAGE_ATTR}]`)
					: null;
			// The element layer uses the same hit for hover and click on its page.
			if (page?.hasAttribute("data-layout-element-selection")) return;
			if (
				selectionOwns(root, event, origin) ||
				root.hasAttribute("data-pdf-selecting") ||
				linkPreviewDragActive()
			) {
				suppressLayoutSentenceHover();
				return;
			}
			releaseLayoutSentenceHover();
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
			if (!page || page.hasAttribute("data-layout-element-selection")) return;
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
			// Turning the setting off unmounts these listeners. A wash held by
			// the selection toolbar has to drop with them.
			releaseHeldLayoutSentenceHover(docId);
			const current = layoutSentenceHover();
			if (current?.docId === docId) clearLayoutSentenceHover();
		};
	}, [docId, hostRef, enabled]);
}

/** Visible sentence lines also anchor the action menu on translated pages. */
export function translatedSentenceRects(
	shell: HTMLElement,
	pageIndex: number,
	sentence: LayoutSentenceHover,
	page = shell.getBoundingClientRect(),
): SentenceFractionRect[] {
	if (!page.width || !page.height) return [];
	const range = document.createRange();
	return sentence.members.flatMap((member) => {
		if (member.pageIndex !== pageIndex) return [];
		const nodes = shell.querySelectorAll<HTMLElement>(
			`[data-layout-item="${CSS.escape(member.itemId)}"] [data-sentence="${member.sentenceIndex}"]`,
		);
		return Array.from(nodes).flatMap((node) => {
			range.selectNodeContents(node);
			return translatedSelectionLineRects(shell, range).map((line) => ({
				x: (line.left - page.left) / page.width,
				y: (line.top - page.top) / page.height,
				w: line.width / page.width,
				h: line.height / page.height,
			}));
		});
	});
}

function sentenceBandsOnPage(
	shell: HTMLElement,
	docId: string,
	pageIndex: number,
	source: boolean,
	sentence: LayoutSentenceHover,
	page: DOMRect,
): SentenceFractionRect[] {
	const members = sentence.members.filter(
		(member) => member.pageIndex === pageIndex,
	);
	if (!members.length || !page.width || !page.height) return [];
	if (!source) {
		const rendered = translatedSentenceRects(shell, pageIndex, sentence, page);
		const translated = rendered.length
			? rendered
			: companionReflowSentenceBands(
					layoutSentenceCatalogItems(docId),
					members,
					pageIndex,
				);
		if (translated?.length) {
			return translated.map((rect) => ({ ...rect, y: rect.y - rect.h * 0.12 }));
		}
	}
	const glyphs = members.flatMap((member) => member.rects);
	const rects = glyphs.length
		? glyphs
		: sentence.pageIndex === pageIndex
			? sentence.rects
			: [];
	const lines = layoutSentenceLineRects(docId, pageIndex);
	return sourceSentenceHoverBands(
		rects,
		Math.round(page.width),
		Math.round(page.height),
		lines.length ? lines : undefined,
	);
}

function paintSentenceBands(
	layer: HTMLElement,
	rects: readonly SentenceFractionRect[],
) {
	const visible = rects.length > 0;
	if (!visible && !layer.childElementCount) return;
	const content = document.createDocumentFragment();
	for (const rect of rects) {
		const node = document.createElement("span");
		Object.assign(node.style, {
			left: `${rect.x * 100}%`,
			top: `${rect.y * 100}%`,
			width: `${rect.w * 100}%`,
			height: `${rect.h * 100}%`,
		});
		content.append(node);
	}
	layer.classList.toggle("is-on", visible);
	layer.replaceChildren(content);
}

/** One painter per page, with independent bands for hover and selected sentences. */
export function PdfSentenceHighlight({
	docId,
	pageIndex,
	source = false,
	elementSelection = false,
}: {
	docId: string;
	pageIndex: number;
	source?: boolean;
	elementSelection?: boolean;
}) {
	const { t } = useTranslation("viewer");
	const selectedRef = useRef<HTMLDivElement>(null);
	const hoverRef = useRef<HTMLDivElement>(null);
	const frameRef = useRef<SVGSVGElement>(null);
	const outlineRef = useRef<SVGPathElement>(null);
	const chipRef = useRef<HTMLSpanElement>(null);
	const repaintRef = useRef<(() => void) | null>(null);
	useLayoutEffect(() => {
		const selectedLayer = selectedRef.current;
		const hoverLayer = hoverRef.current;
		const frames = frameRef.current;
		const outline = outlineRef.current;
		const chip = chipRef.current;
		const shell = hoverLayer?.parentElement;
		if (!selectedLayer || !hoverLayer || !shell) return;
		let hoverHost: HTMLElement | null = null;

		const setHoverHost = (host: HTMLElement | null) => {
			if (host === hoverHost) return;
			hoverHost?.classList.remove("has-sentence");
			hoverHost = host;
			hoverHost?.classList.add("has-sentence");
		};
		const bandsFor = (sentence: LayoutSentenceHover, page: DOMRect) =>
			sentenceBandsOnPage(shell, docId, pageIndex, source, sentence, page);

		const paintSelected = () => {
			const { action } = layoutElementActionStore.getState();
			if (
				!action ||
				layoutSentenceScope(action.docId) !== layoutSentenceScope(docId)
			) {
				paintSentenceBands(selectedLayer, []);
				return;
			}
			const page = shell.getBoundingClientRect();
			const bands = action.members.flatMap(({ sentence }) =>
				sentence ? bandsFor(sentence, page) : [],
			);
			paintSentenceBands(selectedLayer, bands);
		};

		const paintHover = () => {
			const scope = layoutSentenceScope(docId);
			const inspecting =
				elementSelection ||
				layoutElementActionStore.getState().selectionDocumentId === scope;
			const current = inspecting
				? layoutSentencePointerHover()
				: layoutSentenceHover();
			const heldDocument = inspecting ? null : heldLayoutSentenceDocument();
			const mine =
				current &&
				layoutSentenceScope(current.docId) === scope &&
				(source || heldDocument !== docId)
					? current
					: null;
			const page = mine?.members.some(
				(member) => member.pageIndex === pageIndex,
			)
				? shell.getBoundingClientRect()
				: null;
			const bands = mine && page ? bandsFor(mine, page) : [];
			hoverLayer.classList.toggle("is-held", Boolean(heldDocument && mine));
			paintSentenceBands(hoverLayer, bands);

			if (!frames || !outline || !chip) return;
			const host =
				mine?.docId === docId && mine.pageIndex === pageIndex && bands.length
					? shell.querySelector<HTMLElement>(
							`[data-layout-element="${CSS.escape(mine.regionId)}"]`,
						)
					: null;
			setHoverHost(host);
			if (host && page) {
				frames.setAttribute("viewBox", `0 0 ${page.width} ${page.height}`);
				outline.setAttribute(
					"d",
					sentenceOutlinePath(bands, page.width, page.height),
				);
			} else if (outline.hasAttribute("d")) {
				outline.removeAttribute("d");
			}
			const first = host ? bands[0] : undefined;
			chip.hidden = !first;
			if (first) {
				chip.style.left = `${first.x * 100}%`;
				chip.style.top = `${first.y * 100}%`;
			}
		};

		const repaint = () => {
			paintSelected();
			paintHover();
		};
		repaintRef.current = repaint;
		const unsubscribeHover = subscribeLayoutSentenceHover(paintHover);
		const unsubscribeAction = layoutElementActionStore.subscribe(
			(state, previous) => {
				if (state.action?.members !== previous.action?.members) paintSelected();
				if (state.selectionDocumentId !== previous.selectionDocumentId)
					paintHover();
			},
		);
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(repaint);
		observer?.observe(shell);

		return () => {
			repaintRef.current = null;
			unsubscribeHover();
			unsubscribeAction();
			observer?.disconnect();
			setHoverHost(null);
		};
	}, [docId, pageIndex, source, elementSelection]);
	useLayoutEffect(() => {
		repaintRef.current?.();
	});

	return (
		<Fragment>
			<div
				ref={selectedRef}
				className="pdf-layout-sentence-wash is-held"
				style={{ zIndex: source ? 6 : 4 }}
				aria-hidden="true"
			/>
			<div
				ref={hoverRef}
				className="pdf-layout-sentence-wash"
				style={{ zIndex: source ? 6 : 4 }}
				aria-hidden="true"
			/>
			{elementSelection ? (
				<Fragment>
					<svg
						ref={frameRef}
						className="pdf-layout-sentence-frames"
						aria-hidden="true"
					>
						<path ref={outlineRef} />
					</svg>
					<span
						ref={chipRef}
						className="pdf-layout-element-chip pdf-layout-sentence-chip"
						aria-hidden="true"
						hidden
					>
						{t("figures.kindSentence")}
					</span>
				</Fragment>
			) : null}
		</Fragment>
	);
}
