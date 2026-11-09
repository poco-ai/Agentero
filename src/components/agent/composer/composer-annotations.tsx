import { Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	placeAnchoredPopover,
	remToPx,
} from "@/components/agent/composer/anchored-popover";
import { AnnotationQuoteBlock } from "@/components/selection/annotation-quote-block";
import { SelectionSourceButton } from "@/components/selection/selection-source-button";
import { Button } from "@/components/ui/button";
import { annotationOrdinal } from "@/lib/agent/annotation-prompt";
import {
	extractSelectionTokens,
	updateSelectionToken,
	withoutSelectionTokens,
} from "@/lib/agent/composer-inline-tokens";
import { releaseAnnotationAnchor } from "@/lib/agent/selection-annotations";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { lookupHighlightColor } from "@/lib/pdf/annotation-ref";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
import { readAnnotationTranslation } from "@/lib/pdf/layout/annotation-translate-display";
import {
	outlineLocationLabelForPaper,
	subscribePaperOutline,
} from "@/lib/pdf/outline-location";

export type SelectionHoverAnchor = {
	id: string;
	anchor: HTMLElement;
};

export function ComposerAnnotations({
	value,
	onChange,
	hover,
	onHoverHold,
	onHoverRelease,
}: {
	value: string;
	onChange: (value: string) => void;
	hover: SelectionHoverAnchor | null;
	onHoverHold: () => void;
	onHoverRelease: () => void;
}) {
	const selections = useMemo(() => extractSelectionTokens(value), [value]);
	const seenIdsRef = useRef<string[]>([]);
	useEffect(() => {
		const ids = selections.map((selection) => selection.id);
		for (const id of seenIdsRef.current) {
			if (!ids.includes(id)) releaseAnnotationAnchor(id);
		}
		seenIdsRef.current = ids;
	}, [selections]);
	const remove = (id?: string) => {
		for (const selection of selections)
			if (!id || selection.id === id) releaseAnnotationAnchor(selection.id);
		onChange(
			id
				? updateSelectionToken(value, id, null)
				: withoutSelectionTokens(value),
		);
	};
	const hovered = hover
		? selections.find((selection) => selection.id === hover.id)
		: undefined;
	if (!hover || !hovered) return null;
	const ordinal = annotationOrdinal(value, "selection", hovered.id);
	const index =
		ordinal == null
			? selections.findIndex((selection) => selection.id === hovered.id)
			: ordinal - 1;
	return (
		<SelectionReferenceCard
			anchor={hover.anchor}
			index={index}
			selection={hovered}
			onHoverHold={onHoverHold}
			onHoverRelease={onHoverRelease}
			onRemove={() => remove(hovered.id)}
		/>
	);
}

export function clientRectMoved(prev: DOMRect, next: DOMRect): boolean {
	return (
		prev.left !== next.left ||
		prev.top !== next.top ||
		prev.width !== next.width ||
		prev.height !== next.height
	);
}

function liveSelectionChip(
	id: string,
	fallback: HTMLElement,
): HTMLElement | null {
	if (fallback.isConnected) return fallback;
	const found = document.querySelector(
		`[data-composer-chip="selection"][data-selection-id="${CSS.escape(id)}"]`,
	);
	return found instanceof HTMLElement ? found : null;
}

function SelectionReferenceCard({
	anchor,
	index,
	selection,
	onHoverHold,
	onHoverRelease,
	onRemove,
}: {
	anchor: HTMLElement;
	index: number;
	selection: SelectionContext;
	onHoverHold: () => void;
	onHoverRelease: () => void;
	onRemove: () => void;
}) {
	const { t } = useTranslation(["viewer", "common"]);
	const appearance = useSelectionQuoteAppearance(selection);
	const cardRef = useRef<HTMLDivElement>(null);
	const selectingQuoteRef = useRef(false);
	const [rect, setRect] = useState(() => anchor.getBoundingClientRect());
	useEffect(() => {
		const onMouseUp = (event: MouseEvent) => {
			if (!selectingQuoteRef.current) return;
			selectingQuoteRef.current = false;
			const card = cardRef.current;
			if (!card) return;
			const selected = document.getSelection();
			const node = selected?.anchorNode;
			if (selected && !selected.isCollapsed && node && card.contains(node)) {
				return;
			}
			if (event.target instanceof Node && card.contains(event.target)) return;
			onHoverRelease();
		};
		const onMouseDown = (event: MouseEvent) => {
			const card = cardRef.current;
			if (!card || selectingQuoteRef.current) return;
			if (event.target instanceof Node && card.contains(event.target)) return;
			const selection = document.getSelection();
			const node = selection?.anchorNode;
			if (selection && !selection.isCollapsed && node && card.contains(node)) {
				onHoverRelease();
			}
		};
		window.addEventListener("mouseup", onMouseUp);
		window.addEventListener("mousedown", onMouseDown);
		return () => {
			window.removeEventListener("mouseup", onMouseUp);
			window.removeEventListener("mousedown", onMouseDown);
		};
	}, [onHoverRelease]);
	// Editing the note rewrites the selection token, which replaces the chip
	// node. Follow the new node instead of closing the card.
	useLayoutEffect(() => {
		const update = () => {
			const live = liveSelectionChip(selection.id, anchor);
			if (!live) {
				if (document.activeElement?.closest("[data-annotation-ui]")) return;
				onHoverRelease();
				return;
			}
			// A new DOMRect is always a new state value. Setting it on every
			// pass retriggers this effect and overflows React's update depth.
			const next = live.getBoundingClientRect();
			setRect((prev) => (clientRectMoved(prev, next) ? next : prev));
		};
		update();
		window.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);
		return () => {
			window.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
		};
	});
	const placeBelow = rect.top < 220;
	if (typeof document === "undefined") return null;
	const position = placeAnchoredPopover(rect, {
		width: remToPx(28),
		viewportWidth: window.innerWidth,
		placeBelow,
	});
	return createPortal(
		// Hover bridge into the card. The note field and delete button own the actions.
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer bridge so the card stays open between the reference and its actions
		<div
			ref={cardRef}
			data-annotation-ui
			className="fixed z-50 max-h-[min(24rem,calc(100vh-2rem))] overflow-y-auto rounded-lg bg-popover p-1.5 text-sm text-popover-foreground shadow-overlay ring-1 ring-foreground/10"
			style={{
				left: position.left,
				top: position.top,
				width: position.width,
				transform: position.transform,
			}}
			onMouseEnter={onHoverHold}
			onMouseLeave={() => {
				if (selectingQuoteRef.current) return;
				const selected = document.getSelection();
				const node = selected?.anchorNode;
				if (
					cardRef.current &&
					selected &&
					!selected.isCollapsed &&
					node &&
					cardRef.current.contains(node)
				) {
					return;
				}
				onHoverRelease();
			}}
			onMouseDown={(event) => {
				const target = event.target as HTMLElement | null;
				if (target?.closest("[data-annotation-selectable]")) {
					selectingQuoteRef.current = true;
					return;
				}
				if (target?.closest("textarea, button, input, a")) return;
				event.preventDefault();
			}}
		>
			<div className="flex items-start gap-2 p-3">
				<span className="text-muted-foreground">{index + 1}.</span>
				<div className="min-w-0 flex-1">
					<div className="mb-2 flex items-center gap-2">
						<div className="min-w-0 flex-1">
							<SelectionSourceButton className="mb-0" selection={selection} />
						</div>
						<Button
							type="button"
							size="icon-sm"
							variant="ghost"
							className="shrink-0"
							aria-label={t("common:remove")}
							onClick={onRemove}
						>
							<Trash2 className="size-4" />
						</Button>
					</div>
					<AnnotationQuoteBlock
						quote={selection.text}
						translation={appearance.translation}
						locationLabel={appearance.locationLabel}
						color={appearance.color ?? DEFAULT_HIGHLIGHT_COLOR}
						showSwatch={selection.origin === "pdf"}
						selectable
						textClassName="text-[13px]"
					/>
				</div>
			</div>
		</div>,
		document.body,
	);
}

function minRectY(rects: SelectionContext["rects"]): number | undefined {
	if (!rects?.length) return undefined;
	let min = Number.POSITIVE_INFINITY;
	for (const rect of rects) {
		if (Number.isFinite(rect.y)) min = Math.min(min, rect.y);
	}
	return Number.isFinite(min) ? min : undefined;
}

function useSelectionQuoteAppearance(selection: SelectionContext): {
	color: HighlightColor | null;
	locationLabel: string | null;
	translation: string | null;
} {
	const paperAbs =
		selection.origin === "pdf" ? (selection.paperAbsPath?.trim() ?? "") : "";
	const annotationId = selection.id.startsWith("ann-")
		? selection.id.slice("ann-".length)
		: undefined;
	const [locationLabel, setLocationLabel] = useState<string | null>(null);
	useEffect(() => {
		if (!paperAbs || selection.page == null) {
			setLocationLabel(null);
			return;
		}
		const page = selection.page;
		const read = () => {
			const y = minRectY(selection.rects);
			setLocationLabel(
				outlineLocationLabelForPaper(paperAbs, {
					page,
					...(y != null ? { y } : {}),
				}),
			);
		};
		read();
		return subscribePaperOutline(paperAbs, read);
	}, [paperAbs, selection.page, selection.rects]);
	const requestKey = `${paperAbs}\n${annotationId ?? ""}\n${selection.page ?? ""}\n${selection.text}`;
	const [loaded, setLoaded] = useState<{
		key: string;
		color: HighlightColor;
		translation: string | null;
	} | null>(null);
	useEffect(() => {
		if (!paperAbs) return;
		let cancelled = false;
		void Promise.all([
			lookupHighlightColor(paperAbs, {
				id: annotationId,
				quote: selection.text,
				page: selection.page,
			}),
			readAnnotationTranslation(paperAbs, selection.text),
		]).then(([color, translation]) => {
			if (cancelled) return;
			setLoaded({
				key: requestKey,
				color: color ?? DEFAULT_HIGHLIGHT_COLOR,
				translation,
			});
		});
		return () => {
			cancelled = true;
		};
	}, [annotationId, paperAbs, requestKey, selection.page, selection.text]);
	if (!paperAbs) {
		return { color: null, locationLabel: null, translation: null };
	}
	const ready = loaded?.key === requestKey ? loaded : null;
	return {
		color: ready?.color ?? DEFAULT_HIGHLIGHT_COLOR,
		locationLabel,
		translation: ready?.translation ?? null,
	};
}
