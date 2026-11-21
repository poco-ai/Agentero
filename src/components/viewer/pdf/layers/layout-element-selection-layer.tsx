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

function openFromRegion(
	docId: string,
	region: PdfLayoutRegion,
	shell: HTMLElement,
	client: { x: number; y: number } | null,
	sentence: LayoutSentenceHover | null,
): void {
	const boxes = layoutElementBoxes(region);
	const sentenceQuote = sentence?.quote.trim() ?? "";
	const rects =
		sentence && sentence.rects.length > 0
			? sentence.rects
			: boxes.map((box) => box.bbox);
	openLayoutElementAction({
		docId,
		regionId: region.id,
		pageIndex: region.pageIndex,
		kind: region.kind,
		quote: sentenceQuote || layoutElementQuote(region),
		bbox: region.bbox,
		rects,
		screen: screenForElement(shell, rects, client),
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
	}: LayoutElementSelectionLayerProps) {
		const { t } = useTranslation("viewer");
		const rootRef = useRef<HTMLDivElement>(null);
		const washRef = useRef<HTMLDivElement>(null);
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
			let fadeTimer = 0;
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
						window.clearTimeout(fadeTimer);
						fadeTimer = window.setTimeout(() => {
							if (!wash.classList.contains("is-on")) wash.replaceChildren();
						}, 80);
					} else {
						window.clearTimeout(fadeTimer);
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
					mine != null &&
					mine.regionId === paintedId &&
					(marked.length > 0 ||
						onPage.some((member) => member.rects.length > 0));
				host?.classList.toggle("has-sentence", sentenceHere);
			};

			const fractionOf = (clientX: number, clientY: number) => {
				const rect = shell.getBoundingClientRect();
				if (!rect.width || !rect.height) return null;
				const x = (clientX - rect.left) / rect.width;
				const y = (clientY - rect.top) / rect.height;
				if (x < 0 || y < 0 || x > 1 || y > 1) return null;
				return { x, y };
			};

			const regionAt = (
				target: EventTarget | null,
				point: { x: number; y: number },
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
				const span = spanFromTarget(target);
				const spanned = span
					? regionsRef.current.find((region) => region.id === span.itemId)
					: undefined;
				return (
					spanned ??
					pickSelectableLayoutRegion(regionsRef.current, point.x, point.y)
				);
			};

			const regionAlongMove = (
				clientX: number,
				clientY: number,
				target: EventTarget | null,
			) => {
				const point = fractionOf(clientX, clientY);
				if (!point) return null;
				const direct = regionAt(target, point);
				if (direct) return { region: direct, point };
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
					if (found) return { region: found, point: back };
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
				const { region: hit, point } = located;
				hoveredId = hit.id;
				syncHot();
				if (sentencePairing) return;
				if (!isLayoutElementTextKind(hit.kind)) {
					clearLayoutSentenceHover();
					return;
				}
				const span = spanFromTarget(target);
				syncLayoutSentencePointer({
					docId,
					regionId: hit.id,
					pageIndex,
					x: point.x,
					y: point.y,
					span: span?.itemId === hit.id ? span : null,
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
				const hit = regionAt(event.target, point);
				if (!hit) return;
				event.preventDefault();
				event.stopPropagation();
				const sentence = isLayoutElementTextKind(hit.kind)
					? sentenceForActivation({
							docId,
							regionId: hit.id,
							pageIndex,
							x: point.x,
							y: point.y,
							span: spanFromTarget(event.target),
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
			paintSentence();
			// A width/height change re-runs this effect, and its cleanup strips the
			// hot classes. Re-apply the pinned frame from the store, or an open
			// card loses its frame on zoom until the pointer moves.
			syncHot();

			return () => {
				shell.removeEventListener("pointermove", onMove);
				shell.removeEventListener("pointerdown", onDown);
				shell.removeEventListener("click", onClick);
				shell.removeEventListener("pointerleave", onLeave);
				unsubscribeAction();
				unsubscribeSentence();
				paintSentenceRef.current = () => undefined;
				window.clearTimeout(fadeTimer);
				for (const node of marked) node.removeAttribute("data-sentence-hot");
				washOf()?.replaceChildren();
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
		}, [docId, pageIndex, regions, sentencePairing, width, height]);

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
