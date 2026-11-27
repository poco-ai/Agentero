/**
 * Hover / keyboard frame for one post-merge layout element.
 *
 * The frame is pointer-events: none, so text selection, links and scrolling
 * keep the event. Hover is a class toggle on the hit element, coalesced to
 * one animation frame — pointermove does not set React state.
 */

import {
	Fragment,
	memo,
	type MouseEvent as ReactMouseEvent,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { selectionBoundsOnScreen } from "@/components/viewer/pdf/coords";
import {
	closeLayoutElementAction,
	type LayoutElementScreen,
	layoutElementActionStore,
	openLayoutElementAction,
} from "@/components/viewer/pdf/layout-element-action-store";
import {
	clearLayoutSentenceHover,
	type LayoutSentenceHover,
	layoutSentenceCatalogItems,
	layoutSentenceHover,
	primeLayoutSentenceGlyphs,
	releaseLayoutSentenceHover,
	sentenceForActivation,
	subscribeLayoutSentenceHover,
	suppressLayoutSentenceHover,
	syncLayoutSentencePointer,
} from "@/components/viewer/pdf/layout-sentence-hover";
import {
	isLayoutElementTextKind,
	isLayoutRegionActivation,
	LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX,
	layoutElementBoxes,
	layoutElementCaptionPage,
	layoutElementPreview,
	layoutElementQuote,
	layoutKindI18nKey,
	layoutSentenceScope,
	type PdfLayoutRegion,
	type PointerOrigin,
	pickSelectableLayoutRegion,
} from "@/lib/pdf/layout";
import { sentenceHoverBands } from "@/lib/pdf/layout/element-sentence";
import {
	mergeClientRectsIntoLines,
	translatedSentenceAtPoint,
} from "@/lib/pdf/layout/visible-selection-rects";

function spanAtPoint(
	target: EventTarget | null,
	x: number,
	y: number,
): { itemId: string; sentenceIndex: number } | null {
	if (!(target instanceof Element)) return null;
	const span = translatedSentenceAtPoint(target, x, y);
	const item = span?.closest("[data-layout-item]");
	if (!span || !item) return null;
	const itemId = item.getAttribute("data-layout-item");
	const index = span.getAttribute("data-sentence");
	const sentenceIndex = Number(index);
	if (!itemId || index == null || !Number.isInteger(sentenceIndex)) return null;
	return { itemId, sentenceIndex };
}

function textDragOwns(
	shell: HTMLElement,
	event: PointerEvent,
	origin: PointerOrigin | null,
): boolean {
	if (shell.closest("[data-pdf-root]")?.hasAttribute("data-pdf-selecting")) {
		return true;
	}
	const selected = document.getSelection();
	if (
		selected &&
		!selected.isCollapsed &&
		selected.toString().trim() &&
		selected.anchorNode &&
		shell.contains(selected.anchorNode)
	) {
		return true;
	}
	if (event.buttons === 1 && origin) {
		const dx = event.clientX - origin.x;
		const dy = event.clientY - origin.y;
		if (
			dx * dx + dy * dy >
			LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX *
				LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX
		) {
			return true;
		}
	}
	return false;
}

type LayoutElementSelectionLayerProps = {
	docId: string;
	pageIndex: number;
	regions: readonly PdfLayoutRegion[];
	width: number;
	height: number;
	sentencePairing?: boolean;
	sentenceHover?: boolean;
};

function screenForElement(
	shell: HTMLElement,
	rects: PdfLayoutRegion["bbox"][],
	client: { x: number; y: number } | null,
): LayoutElementScreen {
	const bounds = selectionBoundsOnScreen(shell, rects);
	if (!bounds) {
		return { x: client?.x ?? 0, y: client?.y ?? 0, cursorX: client?.x };
	}
	return {
		x: client?.x ?? (bounds.left + bounds.right) / 2,
		y: bounds.top,
		top: bounds.top,
		bottom: bounds.bottom,
		cursorX: client?.x ?? (bounds.left + bounds.right) / 2,
		selectionBounds: bounds,
		side: "above",
	};
}

function translatedSentenceRects(
	shell: HTMLElement,
	pageIndex: number,
	sentence: LayoutSentenceHover,
): PdfLayoutRegion["bbox"][] {
	const page = shell.getBoundingClientRect();
	if (!page.width || !page.height) return [];
	const range = document.createRange();
	return sentence.members.flatMap((member) => {
		if (member.pageIndex !== pageIndex) return [];
		const node = shell.querySelector(
			`[data-layout-item="${CSS.escape(member.itemId)}"] [data-sentence="${member.sentenceIndex}"]`,
		);
		if (!node) return [];
		range.selectNodeContents(node);
		return mergeClientRectsIntoLines(Array.from(range.getClientRects())).map(
			({ left, top, width, height }) => ({
				x: (left - page.left) / page.width,
				y: (top - page.top) / page.height,
				w: width / page.width,
				h: height / page.height,
			}),
		);
	});
}

function openFromRegion(
	docId: string,
	region: PdfLayoutRegion,
	shell: HTMLElement,
	client: { x: number; y: number } | null,
	sentence: LayoutSentenceHover | null,
): void {
	const boxes = layoutElementBoxes(region);
	const sentenceQuote = sentence?.quote.trim() ?? "";
	const rects = sentence?.rects ?? boxes.map((box) => box.bbox);
	const translated = sentence
		? translatedSentenceRects(shell, region.pageIndex, sentence)
		: [];
	const visibleRects = translated.length ? translated : undefined;
	openLayoutElementAction({
		docId,
		regionId: region.id,
		pageIndex: region.pageIndex,
		kind: region.kind,
		quote: sentenceQuote || layoutElementQuote(region),
		bbox: region.bbox,
		rects,
		visibleRects,
		screen: screenForElement(shell, visibleRects ?? rects, client),
		sentence: sentence ?? undefined,
	});
}

export const LayoutElementSelectionLayer = memo(
	function LayoutElementSelectionLayer({
		docId,
		pageIndex,
		regions,
		width,
		height,
		sentencePairing = false,
		sentenceHover = true,
	}: LayoutElementSelectionLayerProps) {
		const { t } = useTranslation("viewer");
		const rootRef = useRef<HTMLDivElement>(null);
		const washRef = useRef<HTMLDivElement>(null);
		const sentenceChipRef = useRef<HTMLSpanElement>(null);
		const regionsRef = useRef(regions);
		const paintSentenceRef = useRef<() => void>(() => undefined);
		regionsRef.current = regions;
		useLayoutEffect(() => {
			paintSentenceRef.current();
		});

		useEffect(() => {
			return () => {
				const action = layoutElementActionStore.getState().action;
				if (
					action &&
					action.docId === docId &&
					action.pageIndex === pageIndex
				) {
					closeLayoutElementAction();
				}
			};
		}, [docId, pageIndex]);

		useEffect(() => {
			const root = rootRef.current;
			const shell = root?.parentElement;
			if (!root || !shell || regions.length === 0) return;

			let origin: PointerOrigin | null = null;
			let raf = 0;
			let pending: PointerEvent | null = null;
			let hoveredId: string | null = null;
			let paintedId: string | null = null;
			let lastClient: { x: number; y: number } | null = null;

			const elementOf = (id: string) =>
				root.querySelector<HTMLElement>(
					`[data-layout-element="${CSS.escape(id)}"]`,
				);

			const pinnedId = () => {
				const action = layoutElementActionStore.getState().action;
				if (
					!action ||
					action.docId !== docId ||
					action.pageIndex !== pageIndex
				) {
					return null;
				}
				return action.regionId;
			};

			const syncHot = () => {
				const pinned = pinnedId();
				const next = pinned ?? hoveredId;
				if (next !== paintedId) {
					if (paintedId) {
						const previous = elementOf(paintedId);
						previous?.classList.remove("is-hot", "is-pinned", "has-sentence");
					}
					if (next) elementOf(next)?.classList.add("is-hot");
					paintedId = next;
				}
				// The open action pins its block: a heavier frame survives the pointer
				// leaving, so "hovered" and "this card is about this block" differ.
				if (next)
					elementOf(next)?.classList.toggle("is-pinned", pinned === next);
			};

			let marked: HTMLElement[] = [];
			const washOf = () => washRef.current;

			const paintSentence = () => {
				const action = layoutElementActionStore.getState().action;
				const current = action ? action.sentence : layoutSentenceHover();
				const mine =
					current &&
					layoutSentenceScope(current.docId) === layoutSentenceScope(docId)
						? current
						: null;
				const onPage =
					mine?.members.filter((member) => member.pageIndex === pageIndex) ??
					[];
				for (const node of marked) node.removeAttribute("data-sentence-hot");
				marked = [];
				for (const member of onPage) {
					if (member.rects.length === 0) {
						primeLayoutSentenceGlyphs(member.pageIndex, docId);
					}
					const nodes = shell.querySelectorAll<HTMLElement>(
						`[data-layout-item="${CSS.escape(member.itemId)}"] [data-sentence="${member.sentenceIndex}"]`,
					);
					for (const node of sentencePairing ? [] : nodes) {
						node.setAttribute("data-sentence-hot", "1");
						marked.push(node);
					}
				}
				const wash = washOf();
				if (wash) {
					const rects = sentencePairing
						? []
						: sentenceHoverBands(
								onPage.flatMap((member) => member.rects),
								width,
								height,
							);
					if (rects.length === 0) {
						wash.classList.remove("is-on");
						wash.replaceChildren();
					} else {
						wash.replaceChildren(
							...rects.map((rect) => {
								const node = document.createElement("span");
								node.style.left = `${rect.x * 100}%`;
								node.style.top = `${rect.y * 100}%`;
								node.style.width = `${rect.w * 100}%`;
								node.style.height = `${rect.h * 100}%`;
								return node;
							}),
						);
						wash.classList.add("is-on");
					}
				}
				const host = paintedId ? elementOf(paintedId) : null;
				const sentenceHere =
					mine?.docId === docId &&
					mine.regionId === paintedId &&
					mine.pageIndex === pageIndex;
				host?.classList.toggle("has-sentence", sentenceHere);
				const chip = sentenceChipRef.current;
				if (chip) {
					const translated = sentenceHere
						? translatedSentenceRects(shell, pageIndex, mine)
						: [];
					const first = translated[0] ?? (sentenceHere ? mine.rects[0] : null);
					chip.hidden = !first;
					if (first) {
						chip.style.left = `${first.x * 100}%`;
						chip.style.top = `${first.y * 100}%`;
					}
				}
			};

			const fractionOf = (clientX: number, clientY: number) => {
				const rect = shell.getBoundingClientRect();
				if (!rect.width || !rect.height) return null;
				const x = (clientX - rect.left) / rect.width;
				const y = (clientY - rect.top) / rect.height;
				if (x < 0 || y < 0 || x > 1 || y > 1) return null;
				return { x, y };
			};

			const formulas = regions.filter((region) => region.kind === "formula");
			const regionAt = (
				target: EventTarget | null,
				point: { x: number; y: number },
				span: ReturnType<typeof spanAtPoint>,
			) => {
				const chipId =
					target instanceof Element
						? target
								.closest("[data-layout-element]")
								?.getAttribute("data-layout-element")
						: null;
				const chipRegion = chipId
					? regionsRef.current.find((region) => region.id === chipId)
					: null;
				if (chipRegion) return chipRegion;
				const formula = pickSelectableLayoutRegion(formulas, point.x, point.y);
				if (formula) return formula;
				const regions = regionsRef.current;
				if (span) {
					const exact = regions.find((region) => region.id === span.itemId);
					if (exact) return exact;
					const item = layoutSentenceCatalogItems(docId).find(
						(item) => item.id === span.itemId && item.pageIndex === pageIndex,
					);
					const textRegions = regions.filter((region) =>
						isLayoutElementTextKind(region.kind),
					);
					const bbox = item?.bbox;
					const source =
						bbox &&
						pickSelectableLayoutRegion(
							textRegions,
							bbox.x + bbox.w / 2,
							bbox.y + bbox.h / 2,
						);
					return (
						source ?? pickSelectableLayoutRegion(textRegions, point.x, point.y)
					);
				}
				return pickSelectableLayoutRegion(regions, point.x, point.y);
			};

			const regionAlongMove = (
				clientX: number,
				clientY: number,
				target: EventTarget | null,
			) => {
				const point = fractionOf(clientX, clientY);
				if (!point) return null;
				const span = spanAtPoint(target, clientX, clientY);
				const direct = regionAt(target, point, span);
				if (direct) return { region: direct, point, span };
				const previous = lastClient;
				if (!previous) return null;
				const dx = clientX - previous.x;
				const dy = clientY - previous.y;
				const dist = Math.hypot(dx, dy);
				// Slow moves trust the point under the cursor. A frame that jumps
				// past a block still activates the block it just crossed.
				if (dist < 16) return null;
				const reach = Math.min(dist, 28);
				const steps = Math.min(3, Math.ceil(reach / 10));
				for (let step = 1; step <= steps; step++) {
					const scale = (reach * (step / steps)) / dist;
					const back = fractionOf(clientX - dx * scale, clientY - dy * scale);
					if (!back) continue;
					const found = pickSelectableLayoutRegion(
						regionsRef.current,
						back.x,
						back.y,
					);
					if (found) return { region: found, point: back, span: null };
				}
				return null;
			};

			const applyHover = () => {
				raf = 0;
				const event = pending;
				pending = null;
				if (!event) return;
				const target = event.target;
				if (
					target instanceof Element &&
					target.closest("[data-pdf-chrome], [data-selection-menu]")
				) {
					lastClient = null;
					hoveredId = null;
					syncHot();
					clearLayoutSentenceHover();
					return;
				}
				if (textDragOwns(shell, event, origin)) {
					lastClient = null;
					hoveredId = null;
					syncHot();
					suppressLayoutSentenceHover();
					return;
				}
				releaseLayoutSentenceHover();
				const located = regionAlongMove(event.clientX, event.clientY, target);
				lastClient = { x: event.clientX, y: event.clientY };
				if (!located) {
					hoveredId = null;
					syncHot();
					clearLayoutSentenceHover();
					return;
				}
				const { region: hit, point, span } = located;
				hoveredId = hit.id;
				syncHot();
				if (
					!sentenceHover ||
					!isLayoutElementTextKind(hit.kind) ||
					(!span &&
						target instanceof Element &&
						target.closest("[data-layout-element], [data-layout-item]"))
				) {
					clearLayoutSentenceHover();
					return;
				}
				syncLayoutSentencePointer({
					docId,
					regionId: hit.id,
					pageIndex,
					x: point.x,
					y: point.y,
					span,
				});
			};

			const onMove = (event: PointerEvent) => {
				pending = event;
				if (raf) return;
				raf = requestAnimationFrame(applyHover);
			};

			const onDown = (event: PointerEvent) => {
				if (event.button !== 0) return;
				origin = { x: event.clientX, y: event.clientY };
			};

			const onClick = (event: MouseEvent) => {
				const target = event.target;
				if (
					target instanceof Element &&
					target.closest(
						"[data-pdf-chrome], [data-selection-menu], [data-layout-element], a, button",
					)
				) {
					return;
				}
				const start = origin;
				origin = null;
				if (
					!isLayoutRegionActivation({
						detail: event.detail,
						origin: start,
						end: { x: event.clientX, y: event.clientY },
					})
				) {
					return;
				}
				const selected = document.getSelection();
				if (
					selected &&
					!selected.isCollapsed &&
					selected.toString().trim() &&
					selected.anchorNode &&
					shell.contains(selected.anchorNode)
				) {
					return;
				}
				const point = fractionOf(event.clientX, event.clientY);
				if (!point) return;
				const span = spanAtPoint(target, event.clientX, event.clientY);
				const hit = regionAt(target, point, span);
				if (!hit) return;
				event.preventDefault();
				event.stopPropagation();
				const sentence =
					sentenceHover &&
					isLayoutElementTextKind(hit.kind) &&
					(span ||
						!(
							target instanceof Element && target.closest("[data-layout-item]")
						))
						? sentenceForActivation({
								docId,
								regionId: hit.id,
								pageIndex,
								x: point.x,
								y: point.y,
								span,
							})
						: null;
				openFromRegion(
					docId,
					hit,
					shell,
					{ x: event.clientX, y: event.clientY },
					sentence,
				);
			};

			const onLeave = () => {
				if (raf) cancelAnimationFrame(raf);
				raf = 0;
				pending = null;
				lastClient = null;
				hoveredId = null;
				syncHot();
				clearLayoutSentenceHover();
			};

			shell.addEventListener("pointermove", onMove);
			shell.addEventListener("pointerdown", onDown);
			shell.addEventListener("click", onClick);
			shell.addEventListener("pointerleave", onLeave);
			paintSentenceRef.current = paintSentence;
			const unsubscribeAction = layoutElementActionStore.subscribe(() => {
				syncHot();
				paintSentence();
			});
			const unsubscribeSentence = subscribeLayoutSentenceHover(paintSentence);
			// A width/height change re-runs this effect, and its cleanup strips the
			// hot classes. Re-apply the pinned frame from the store, or an open
			// card loses its frame on zoom until the pointer moves.
			syncHot();
			paintSentence();

			return () => {
				shell.removeEventListener("pointermove", onMove);
				shell.removeEventListener("pointerdown", onDown);
				shell.removeEventListener("click", onClick);
				shell.removeEventListener("pointerleave", onLeave);
				unsubscribeAction();
				unsubscribeSentence();
				paintSentenceRef.current = () => undefined;
				for (const node of marked) node.removeAttribute("data-sentence-hot");
				washOf()?.replaceChildren();
				const chip = sentenceChipRef.current;
				if (chip) chip.hidden = true;
				if (raf) cancelAnimationFrame(raf);
				if (paintedId) {
					const previous = elementOf(paintedId);
					previous?.classList.remove("is-hot", "is-pinned", "has-sentence");
				}
				const current = layoutSentenceHover();
				if (current?.docId === docId && current.pageIndex === pageIndex) {
					clearLayoutSentenceHover();
				}
			};
		}, [
			docId,
			pageIndex,
			regions,
			sentencePairing,
			sentenceHover,
			width,
			height,
		]);

		return (
			<Fragment>
				{/*
				 * Direct child of the page shell. A wash inside `display: contents`
				 * does not paint above the text layer in WKWebView, so the English
				 * sentence stayed invisible while the translation span did not.
				 */}
				<div
					ref={washRef}
					className="pdf-layout-sentence-wash"
					data-layout-sentence-wash
					style={{ zIndex: 6 }}
					aria-hidden="true"
				/>
				<span
					ref={sentenceChipRef}
					className="pdf-layout-element-chip pdf-layout-sentence-chip"
					aria-hidden="true"
					hidden
				>
					{t("figures.kindSentence")}
				</span>
				<div ref={rootRef} className="contents">
					{regions.map((region) => {
						const boxes = layoutElementBoxes(region);
						const kindLabel = t(layoutKindI18nKey(region.kind));
						const quote = layoutElementQuote(region);
						const preview = layoutElementPreview(quote);
						const captionPage = layoutElementCaptionPage(region);
						const anchor = boxes.reduce((top, box) =>
							box.bbox.y < top.bbox.y ? box : top,
						);
						const aria = preview
							? t("figures.selectElementAriaPreview", {
									kind: kindLabel,
									preview,
								})
							: t("figures.selectElementAria", { kind: kindLabel });
						return (
							<div
								key={region.id}
								data-layout-element={region.id}
								data-layout-kind={region.kind}
								data-layout-text={
									isLayoutElementTextKind(region.kind) ? "1" : "0"
								}
								className="contents"
							>
								{boxes.map((box) => (
									<div
										key={box.key}
										className="pdf-layout-element-frame"
										style={{
											left: `${box.bbox.x * 100}%`,
											top: `${box.bbox.y * 100}%`,
											width: `${box.bbox.w * 100}%`,
											height: `${box.bbox.h * 100}%`,
										}}
										aria-hidden="true"
									/>
								))}
								<button
									type="button"
									className="pdf-layout-element-chip"
									style={{
										left: `${anchor.bbox.x * 100}%`,
										top: `${anchor.bbox.y * 100}%`,
									}}
									aria-label={aria}
									title={aria}
									onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
										event.preventDefault();
										event.stopPropagation();
										const shell = rootRef.current?.parentElement;
										if (!(shell instanceof HTMLElement)) return;
										clearLayoutSentenceHover();
										openFromRegion(docId, region, shell, null, null);
									}}
								>
									<span className="font-medium">{kindLabel}</span>
									{captionPage != null ? (
										<span className="font-normal text-muted-foreground">
											{" "}
											· {t("figures.captionOnPage", { page: captionPage })}
										</span>
									) : null}
								</button>
							</div>
						);
					})}
				</div>
			</Fragment>
		);
	},
);
