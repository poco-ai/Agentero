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
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { selectionBoundsOnScreen } from "@/components/viewer/pdf/coords";
import { PDF_VISUAL_REGION_FRAME_CLASS } from "@/components/viewer/pdf/layers/visual-region-frame";
import {
	anchorLayoutElementAction,
	beginLayoutElementCropGesture,
	closeLayoutElementAction,
	endLayoutElementCropGesture,
	type LayoutElementActionMember,
	type LayoutElementScreen,
	layoutElementActionStore,
	openLayoutElementAction,
} from "@/components/viewer/pdf/layout-element-action-store";
import {
	clearLayoutSentenceHover,
	type LayoutSentenceHover,
	layoutSentenceCatalogItems,
	layoutSentencePointerHover,
	releaseLayoutSentenceHover,
	sentenceForActivation,
	suppressLayoutSentenceHover,
	syncLayoutSentencePointer,
} from "@/components/viewer/pdf/layout-sentence-hover";
import { translatedSentenceRects } from "@/components/viewer/pdf/layout-sentence-pairing";
import {
	isLayoutElementTextKind,
	isLayoutRegionActivation,
	LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX,
	layoutElementBoxes,
	layoutElementCaptionPage,
	layoutElementPreview,
	layoutElementQuote,
	layoutKindI18nKey,
	type PdfLayoutRegion,
	type PointerOrigin,
	pickSelectableLayoutRegion,
} from "@/lib/pdf/layout";
import { translatedSentenceAtPoint } from "@/lib/pdf/layout/visible-selection-rects";
import { normalizedRegionFromPoints } from "@/lib/pdf/region";

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

function openFromRegion(
	docId: string,
	region: PdfLayoutRegion,
	shell: HTMLElement,
	client: { x: number; y: number } | null,
	sentence: LayoutSentenceHover | null,
): void {
	const boxes = layoutElementBoxes(region);
	const sentenceQuote = sentence?.quote.trim() ?? "";
	const rects = sentence
		? sentence.members
				.filter((member) => member.pageIndex === region.pageIndex)
				.flatMap((member) => member.rects)
		: boxes.map((box) => box.bbox);
	if (sentence && !rects.length) rects.push(...sentence.rects);
	const translated = sentence
		? translatedSentenceRects(shell, region.pageIndex, sentence)
		: [];
	const visibleRects = translated.length ? translated : undefined;
	const member: LayoutElementActionMember = {
		id: sentence ? JSON.stringify([region.id, sentence.key]) : region.id,
		source: "element",
		regionId: region.id,
		pageIndex: region.pageIndex,
		kind: region.kind,
		quote: sentenceQuote || layoutElementQuote(region),
		bbox: region.bbox,
		rects,
		visibleRects,
		sentence: sentence ?? undefined,
	};
	const action = layoutElementActionStore.getState().action;
	const existingMembers =
		action?.docId === docId &&
		action.pageIndex === member.pageIndex &&
		action.members.every((item) => item.source === "element")
			? action.members
			: [];
	const removing = existingMembers.some((item) => item.id === member.id);
	const members = removing
		? existingMembers.filter((item) => item.id !== member.id)
		: [...existingMembers, member];
	const anchor = members.at(-1);
	if (!anchor) {
		closeLayoutElementAction();
		return;
	}
	openLayoutElementAction({
		docId,
		pageIndex: anchor.pageIndex,
		anchorId: anchor.id,
		members,
		screen: screenForElement(
			shell,
			anchor.visibleRects ?? anchor.rects,
			removing ? null : client,
		),
	});
}

function openFromCrop(
	docId: string,
	pageIndex: number,
	rect: PdfLayoutRegion["bbox"],
	shell: HTMLElement,
): void {
	const member: LayoutElementActionMember = {
		id: `region:${crypto.randomUUID()}`,
		source: "region",
		pageIndex,
		kind: "region",
		quote: "",
		bbox: rect,
		rects: [rect],
	};
	openLayoutElementAction({
		docId,
		pageIndex,
		anchorId: member.id,
		members: [member],
		screen: screenForElement(shell, member.rects, null),
	});
}

export const LayoutElementSelectionLayer = memo(
	function LayoutElementSelectionLayer({
		docId,
		pageIndex,
		regions,
		sentenceHover = true,
	}: LayoutElementSelectionLayerProps) {
		const { t } = useTranslation("viewer");
		const rootRef = useRef<HTMLDivElement>(null);
		const regionFrameRef = useRef<HTMLDivElement>(null);
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
			if (!root || !shell) return;

			let origin: PointerOrigin | null = null;
			let raf = 0;
			let pending: PointerEvent | null = null;
			let hoveredId: string | null = null;
			let paintedPinnedId: string | null = null;
			let lastClient: { x: number; y: number } | null = null;
			let paintedSelected = new Set<string>();
			let cropPointerId: number | null = null;
			let cropStartFraction: { x: number; y: number } | null = null;
			let cropCurrentFraction: { x: number; y: number } | null = null;
			let cropGesture = false;

			const elementOf = (id: string) =>
				root.querySelector<HTMLElement>(
					`[data-layout-element="${CSS.escape(id)}"]`,
				);

			const paintRegionFrame = (box: PdfLayoutRegion["bbox"] | null) => {
				const frame = regionFrameRef.current;
				if (!frame) return;
				if (!box || box.w <= 0 || box.h <= 0) {
					frame.hidden = true;
					return;
				}
				frame.hidden = false;
				frame.style.left = `${box.x * 100}%`;
				frame.style.top = `${box.y * 100}%`;
				frame.style.width = `${box.w * 100}%`;
				frame.style.height = `${box.h * 100}%`;
			};

			const setCropReady = (active: boolean) => {
				shell.classList.toggle("is-layout-crop-ready", active);
			};

			const syncBlockFrames = () => {
				const action = layoutElementActionStore.getState().action;
				const onPage =
					action?.docId === docId && action.pageIndex === pageIndex
						? action
						: null;
				const anchor = onPage ? anchorLayoutElementAction(onPage) : null;
				const selected = new Set(
					onPage?.members.flatMap((member) =>
						member.source === "element" && member.regionId && !member.sentence
							? [member.regionId]
							: [],
					),
				);
				for (const id of paintedSelected) {
					if (!selected.has(id)) elementOf(id)?.classList.remove("is-selected");
				}
				for (const id of selected) {
					if (!paintedSelected.has(id))
						elementOf(id)?.classList.add("is-selected");
				}
				paintedSelected = selected;
				if (!cropGesture)
					paintRegionFrame(anchor?.source === "region" ? anchor.bbox : null);

				const pinned = anchor?.sentence ? null : (anchor?.regionId ?? null);
				if (pinned !== paintedPinnedId) {
					if (paintedPinnedId)
						elementOf(paintedPinnedId)?.classList.remove("is-pinned");
					if (pinned) elementOf(pinned)?.classList.add("is-pinned");
					paintedPinnedId = pinned;
				}
			};

			const setHoveredBlock = (id: string | null) => {
				if (id === hoveredId) return;
				if (hoveredId) elementOf(hoveredId)?.classList.remove("is-hot");
				hoveredId = id;
				if (id) elementOf(id)?.classList.add("is-hot");
			};

			const fractionOf = (clientX: number, clientY: number) => {
				const rect = shell.getBoundingClientRect();
				if (!rect.width || !rect.height) return null;
				const x = (clientX - rect.left) / rect.width;
				const y = (clientY - rect.top) / rect.height;
				if (x < 0 || y < 0 || x > 1 || y > 1) return null;
				return { x, y };
			};

			const clampedFraction = (clientX: number, clientY: number) => {
				const rect = shell.getBoundingClientRect();
				if (!rect.width || !rect.height) return { x: 0, y: 0 };
				return {
					x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
					y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
				};
			};

			const cropBox = (
				start: { x: number; y: number },
				end: { x: number; y: number },
			) => {
				const left = Math.min(start.x, end.x);
				const top = Math.min(start.y, end.y);
				const right = Math.max(start.x, end.x);
				const bottom = Math.max(start.y, end.y);
				return {
					x: left,
					y: top,
					w: right - left,
					h: bottom - top,
				};
			};

			const preventSelection = (event: Event) => event.preventDefault();

			const startCrop = (event: PointerEvent) => {
				if (!cropStartFraction || cropGesture) return;
				cropGesture = true;
				closeLayoutElementAction();
				paintRegionFrame(null);
				beginLayoutElementCropGesture(docId);
				document.getSelection()?.removeAllRanges();
				setHoveredBlock(null);
				suppressLayoutSentenceHover();
				setCropReady(false);
				document.addEventListener("selectstart", preventSelection, true);
				shell.classList.add("is-layout-crop-dragging");
				try {
					shell.setPointerCapture(event.pointerId);
				} catch {
					// Pointer capture is best-effort; page listeners still receive moves.
				}
			};

			const updateCrop = (event: PointerEvent) => {
				cropCurrentFraction = clampedFraction(event.clientX, event.clientY);
				paintRegionFrame(
					cropBox(
						cropStartFraction ?? cropCurrentFraction,
						cropCurrentFraction,
					),
				);
			};

			const cleanupCrop = () => {
				if (cropPointerId != null && shell.hasPointerCapture(cropPointerId)) {
					try {
						shell.releasePointerCapture(cropPointerId);
					} catch {
						// Capture may already be gone after a cancel.
					}
				}
				setCropReady(false);
				if (cropGesture) {
					document.removeEventListener("selectstart", preventSelection, true);
					shell.classList.remove("is-layout-crop-dragging");
					paintRegionFrame(null);
					endLayoutElementCropGesture(docId);
				}
				cropGesture = false;
				cropPointerId = null;
				cropStartFraction = null;
				cropCurrentFraction = null;
			};

			const finishCrop = (commit: boolean) => {
				const start = cropStartFraction;
				const end = cropCurrentFraction;
				cleanupCrop();
				if (!commit || !start || !end) return;
				const region = normalizedRegionFromPoints(start, end);
				if (!region) return;
				shell.setAttribute("data-layout-crop-release", "1");
				window.setTimeout(() => {
					shell.removeAttribute("data-layout-crop-release");
				}, 400);
				openFromCrop(docId, pageIndex, region, shell);
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
					? regions.find((region) => region.id === chipId)
					: null;
				if (chipRegion) return chipRegion;
				const formula = pickSelectableLayoutRegion(formulas, point.x, point.y);
				if (formula) return formula;
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
					const found = pickSelectableLayoutRegion(regions, back.x, back.y);
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
					setHoveredBlock(null);
					clearLayoutSentenceHover();
					return;
				}
				if (textDragOwns(shell, event, origin)) {
					lastClient = null;
					setHoveredBlock(null);
					suppressLayoutSentenceHover();
					return;
				}
				releaseLayoutSentenceHover();
				const located = regionAlongMove(event.clientX, event.clientY, target);
				lastClient = { x: event.clientX, y: event.clientY };
				if (!located) {
					setHoveredBlock(null);
					clearLayoutSentenceHover();
					return;
				}
				const { region: hit, point, span } = located;
				setHoveredBlock(hit.id);
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
					elementSelection: true,
				});
			};

			const onMove = (event: PointerEvent) => {
				if (cropGesture) {
					updateCrop(event);
					return;
				}
				setCropReady(event.altKey || event.metaKey);
				if (origin && cropPointerId === event.pointerId) {
					const dx = event.clientX - origin.x;
					const dy = event.clientY - origin.y;
					if (
						dx * dx + dy * dy >
						LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX *
							LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX
					) {
						startCrop(event);
						updateCrop(event);
						return;
					}
				}
				pending = event;
				if (raf) return;
				raf = requestAnimationFrame(applyHover);
			};

			const onDown = (event: PointerEvent) => {
				if (event.button !== 0) return;
				const target = event.target;
				if (
					target instanceof Element &&
					target.closest(
						"[data-pdf-chrome], [data-selection-menu], [data-layout-element], a, button",
					)
				) {
					cropPointerId = null;
					cropStartFraction = null;
					return;
				}
				origin = { x: event.clientX, y: event.clientY };
				cropPointerId = event.altKey || event.metaKey ? event.pointerId : null;
				cropStartFraction =
					cropPointerId != null
						? clampedFraction(event.clientX, event.clientY)
						: null;
				cropCurrentFraction = cropStartFraction;
			};

			const onClick = (event: MouseEvent) => {
				if (event.detail > 1) return;
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
				if (!hit) {
					closeLayoutElementAction();
					return;
				}
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
								elementSelection: true,
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

			const onPointerEnd = (event: PointerEvent) => {
				if (cropGesture) {
					finishCrop(event.type === "pointerup");
					return;
				}
				if (cropPointerId === event.pointerId) cleanupCrop();
			};

			const onLeave = () => {
				if (cropGesture) return;
				setCropReady(false);
				if (raf) cancelAnimationFrame(raf);
				raf = 0;
				pending = null;
				lastClient = null;
				setHoveredBlock(null);
				clearLayoutSentenceHover();
			};

			const onModifierKey = (event: KeyboardEvent) => {
				if (event.key !== "Alt" && event.key !== "Meta") return;
				setCropReady(event.altKey || event.metaKey);
			};
			const onWindowBlur = () => setCropReady(false);

			shell.addEventListener("pointermove", onMove);
			shell.addEventListener("pointerdown", onDown);
			shell.addEventListener("click", onClick);
			shell.addEventListener("pointerleave", onLeave);
			shell.addEventListener("pointerup", onPointerEnd);
			shell.addEventListener("pointercancel", onPointerEnd);
			window.addEventListener("keydown", onModifierKey);
			window.addEventListener("keyup", onModifierKey);
			window.addEventListener("blur", onWindowBlur);
			const unsubscribeAction = layoutElementActionStore.subscribe(
				(state, previous) => {
					if (state.action?.members !== previous.action?.members)
						syncBlockFrames();
				},
			);
			syncBlockFrames();

			return () => {
				shell.removeEventListener("pointermove", onMove);
				shell.removeEventListener("pointerdown", onDown);
				shell.removeEventListener("click", onClick);
				shell.removeEventListener("pointerleave", onLeave);
				shell.removeEventListener("pointerup", onPointerEnd);
				shell.removeEventListener("pointercancel", onPointerEnd);
				window.removeEventListener("keydown", onModifierKey);
				window.removeEventListener("keyup", onModifierKey);
				window.removeEventListener("blur", onWindowBlur);
				cleanupCrop();
				unsubscribeAction();
				if (raf) cancelAnimationFrame(raf);
				setHoveredBlock(null);
				if (paintedPinnedId) {
					elementOf(paintedPinnedId)?.classList.remove("is-pinned");
				}
				for (const id of paintedSelected) {
					elementOf(id)?.classList.remove("is-selected");
				}
				paintRegionFrame(null);
				const current = layoutSentencePointerHover();
				if (current?.docId === docId && current.pageIndex === pageIndex) {
					clearLayoutSentenceHover();
				}
			};
		}, [docId, pageIndex, regions, sentenceHover]);

		return (
			<Fragment>
				<div
					ref={regionFrameRef}
					className={PDF_VISUAL_REGION_FRAME_CLASS}
					style={{ zIndex: 5 }}
					aria-hidden="true"
					hidden
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
										if (event.detail > 1) return;
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
