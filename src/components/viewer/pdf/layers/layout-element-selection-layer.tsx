/**
 * Hover / keyboard frame for one post-merge layout element.
 *
 * The frame is pointer-events: none, so text selection, links and scrolling
 * keep the event. Hover is a class toggle on the hit element, coalesced to
 * one animation frame — pointermove does not set React state.
 */

import {
	memo,
	type MouseEvent as ReactMouseEvent,
	useEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { selectionBoundsOnScreen } from "@/components/viewer/pdf/coords";
import {
	anchorLayoutElementAction,
	closeLayoutElementAction,
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
		action?.docId === docId && action.pageIndex === member.pageIndex
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

export const LayoutElementSelectionLayer = memo(
	function LayoutElementSelectionLayer({
		docId,
		pageIndex,
		regions,
		sentenceHover = true,
	}: LayoutElementSelectionLayerProps) {
		const { t } = useTranslation("viewer");
		const rootRef = useRef<HTMLDivElement>(null);
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

			const elementOf = (id: string) =>
				root.querySelector<HTMLElement>(
					`[data-layout-element="${CSS.escape(id)}"]`,
				);

			const syncBlockFrames = () => {
				const action = layoutElementActionStore.getState().action;
				const onPage =
					action?.docId === docId && action.pageIndex === pageIndex
						? action
						: null;
				const anchor = onPage ? anchorLayoutElementAction(onPage) : null;
				const selected = new Set(
					onPage?.members.flatMap((member) =>
						member.sentence ? [] : [member.regionId],
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
				pending = event;
				if (raf) return;
				raf = requestAnimationFrame(applyHover);
			};

			const onDown = (event: PointerEvent) => {
				if (event.button !== 0) return;
				origin = { x: event.clientX, y: event.clientY };
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

			const onLeave = () => {
				if (raf) cancelAnimationFrame(raf);
				raf = 0;
				pending = null;
				lastClient = null;
				setHoveredBlock(null);
				clearLayoutSentenceHover();
			};

			shell.addEventListener("pointermove", onMove);
			shell.addEventListener("pointerdown", onDown);
			shell.addEventListener("click", onClick);
			shell.addEventListener("pointerleave", onLeave);
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
				unsubscribeAction();
				if (raf) cancelAnimationFrame(raf);
				setHoveredBlock(null);
				if (paintedPinnedId) {
					elementOf(paintedPinnedId)?.classList.remove("is-pinned");
				}
				for (const id of paintedSelected) {
					elementOf(id)?.classList.remove("is-selected");
				}
				const current = layoutSentencePointerHover();
				if (current?.docId === docId && current.pageIndex === pageIndex) {
					clearLayoutSentenceHover();
				}
			};
		}, [docId, pageIndex, regions, sentenceHover]);

		return (
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
		);
	},
);
