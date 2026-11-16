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
	closeLayoutElementAction,
	type LayoutElementScreen,
	layoutElementActionStore,
	openLayoutElementAction,
} from "@/components/viewer/pdf/layout-element-action-store";
import {
	isLayoutElementTextKind,
	isLayoutRegionActivation,
	LAYOUT_HINT_MIN_REGION_H_PX,
	LAYOUT_HINT_MIN_REGION_W_PX,
	layoutElementBoxes,
	layoutElementCaptionPage,
	layoutElementPreview,
	layoutElementQuote,
	layoutKindI18nKey,
	type PdfLayoutRegion,
	type PointerOrigin,
	pickSelectableLayoutRegion,
} from "@/lib/pdf/layout";

type LayoutElementSelectionLayerProps = {
	docId: string;
	pageIndex: number;
	regions: readonly PdfLayoutRegion[];
	width: number;
	height: number;
	paperDark: boolean;
};

function screenForElement(
	shell: HTMLElement,
	region: PdfLayoutRegion,
	client: { x: number; y: number } | null,
): LayoutElementScreen {
	const rects = layoutElementBoxes(region).map((box) => box.bbox);
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
): void {
	const quote = layoutElementQuote(region);
	const boxes = layoutElementBoxes(region);
	openLayoutElementAction({
		docId,
		regionId: region.id,
		pageIndex: region.pageIndex,
		kind: region.kind,
		quote,
		bbox: region.bbox,
		rects: boxes.map((box) => box.bbox),
		screen: screenForElement(shell, region, client),
	});
}

export const LayoutElementSelectionLayer = memo(
	function LayoutElementSelectionLayer({
		docId,
		pageIndex,
		regions,
		width,
		height,
		paperDark,
	}: LayoutElementSelectionLayerProps) {
		const { t } = useTranslation("viewer");
		const rootRef = useRef<HTMLDivElement>(null);
		const regionsRef = useRef(regions);
		regionsRef.current = regions;

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
				const next = hoveredId ?? pinnedId();
				if (next === paintedId) return;
				if (paintedId) elementOf(paintedId)?.classList.remove("is-hot");
				if (next) elementOf(next)?.classList.add("is-hot");
				paintedId = next;
			};

			const fractionOf = (clientX: number, clientY: number) => {
				const rect = shell.getBoundingClientRect();
				if (!rect.width || !rect.height) return null;
				const x = (clientX - rect.left) / rect.width;
				const y = (clientY - rect.top) / rect.height;
				if (x < 0 || y < 0 || x > 1 || y > 1) return null;
				return { x, y };
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
					hoveredId = null;
					syncHot();
					return;
				}
				const point = fractionOf(event.clientX, event.clientY);
				if (!point) {
					hoveredId = null;
					syncHot();
					return;
				}
				hoveredId =
					pickSelectableLayoutRegion(regionsRef.current, point.x, point.y)
						?.id ?? null;
				syncHot();
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
				const hit = pickSelectableLayoutRegion(
					regionsRef.current,
					point.x,
					point.y,
				);
				if (!hit) return;
				event.preventDefault();
				event.stopPropagation();
				openFromRegion(docId, hit, shell, {
					x: event.clientX,
					y: event.clientY,
				});
			};

			const onLeave = () => {
				if (raf) cancelAnimationFrame(raf);
				raf = 0;
				pending = null;
				hoveredId = null;
				syncHot();
			};

			shell.addEventListener("pointermove", onMove);
			shell.addEventListener("pointerdown", onDown);
			shell.addEventListener("click", onClick);
			shell.addEventListener("pointerleave", onLeave);
			const unsubscribe = layoutElementActionStore.subscribe(syncHot);

			return () => {
				shell.removeEventListener("pointermove", onMove);
				shell.removeEventListener("pointerdown", onDown);
				shell.removeEventListener("click", onClick);
				shell.removeEventListener("pointerleave", onLeave);
				unsubscribe();
				if (raf) cancelAnimationFrame(raf);
				if (paintedId) elementOf(paintedId)?.classList.remove("is-hot");
			};
		}, [docId, pageIndex, regions]);

		return (
			<div
				ref={rootRef}
				className="contents"
				data-paper={paperDark ? "dark" : "light"}
			>
				{regions.map((region) => {
					const boxes = layoutElementBoxes(region);
					const kindLabel = t(layoutKindI18nKey(region.kind));
					const quote = layoutElementQuote(region);
					const preview = layoutElementPreview(quote);
					const captionPage = layoutElementCaptionPage(region);
					const showPreview =
						Boolean(preview) &&
						region.bbox.w * width >= LAYOUT_HINT_MIN_REGION_W_PX &&
						region.bbox.h * height >= LAYOUT_HINT_MIN_REGION_H_PX;
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
								title={preview || kindLabel}
								onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
									event.preventDefault();
									event.stopPropagation();
									const shell = rootRef.current?.parentElement;
									if (!(shell instanceof HTMLElement)) return;
									openFromRegion(docId, region, shell, null);
								}}
							>
								<span className="font-medium">{kindLabel}</span>
								{captionPage != null ? (
									<span className="font-normal text-muted-foreground">
										{" "}
										· {t("figures.captionOnPage", { page: captionPage })}
									</span>
								) : null}
								{showPreview ? (
									<span className="mt-0.5 block max-w-56 truncate font-normal text-muted-foreground">
										{preview}
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
