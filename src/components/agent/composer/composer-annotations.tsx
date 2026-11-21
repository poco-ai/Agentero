import type { TFunction } from "i18next";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	placeAnchoredPopover,
	remToPx,
} from "@/components/agent/composer/anchored-popover";
import { extractSelectionTokens } from "@/lib/agent/composer-inline-tokens";
import {
	normalizeContextPath,
	paperContextRoot,
} from "@/lib/agent/context-path-icon";
import { releaseAnnotationAnchor } from "@/lib/agent/selection-annotations";
import { selectionLineLabel } from "@/lib/agent/selection-line-label";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { cn } from "@/lib/core/utils";
import { readAnnotationTranslation } from "@/lib/pdf/layout/annotation-translate-display";

export type SelectionHoverAnchor = {
	id: string;
	anchor: HTMLElement;
};

export function ComposerAnnotations({
	value,
	hover,
	onHoverHold,
	onHoverRelease,
	labelForPath,
	paperPaths,
}: {
	value: string;
	hover: SelectionHoverAnchor | null;
	onHoverHold: () => void;
	onHoverRelease: () => void;
	/** Same paper label as the file tree / context chips. */
	labelForPath: (path: string) => string;
	/** Vault-relative paper folders, used to split `papers/<dir>/<paper>`. */
	paperPaths: ReadonlySet<string>;
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
	const hovered = hover
		? selections.find((selection) => selection.id === hover.id)
		: undefined;
	if (!hover || !hovered) return null;
	return (
		<SelectionReferenceCard
			anchor={hover.anchor}
			selection={hovered}
			labelForPath={labelForPath}
			paperPaths={paperPaths}
			onHoverHold={onHoverHold}
			onHoverRelease={onHoverRelease}
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

/**
 * Source line above the quote: `Papers / <dirs…> / <paper title>` for a paper
 * selection, otherwise the chip label (path, plus the line span when known).
 */
function selectionSourceLabel(
	selection: SelectionContext,
	labelForPath: (path: string) => string,
	paperPaths: ReadonlySet<string>,
	t: TFunction<"agent">,
): string {
	const rel = normalizeContextPath(selection.sourcePath);
	const paperRoot = paperContextRoot(rel, paperPaths);
	if (paperRoot) {
		const segments = paperRoot.split("/");
		const folder = segments[segments.length - 1] ?? paperRoot;
		return [
			t("composer.referencePaperRoot"),
			...segments.slice(1, -1),
			labelForPath(paperRoot) || folder,
		].join(" / ");
	}
	const fallback = selection.sourceTitle || rel || selection.sourcePath;
	if (selection.lineFrom != null) {
		return selectionLineLabel(t, selection, fallback) ?? fallback;
	}
	return fallback;
}

/**
 * Reference card for one text annotation. Apple-style floating material: a
 * quiet source line, then the quote itself. No ordinal, no locate / delete
 * actions, no highlight swatch — the card only describes the quotation.
 */
function SelectionReferenceCard({
	anchor,
	selection,
	labelForPath,
	paperPaths,
	onHoverHold,
	onHoverRelease,
}: {
	anchor: HTMLElement;
	selection: SelectionContext;
	labelForPath: (path: string) => string;
	paperPaths: ReadonlySet<string>;
	onHoverHold: () => void;
	onHoverRelease: () => void;
}) {
	const { t } = useTranslation("agent");
	const translation = useSelectionTranslation(selection);
	const cardRef = useRef<HTMLDivElement>(null);
	const selectingQuoteRef = useRef(false);
	const [rect, setRect] = useState(() => anchor.getBoundingClientRect());

	// Selecting the quote is a normal reading gesture: releasing outside the
	// card must not dismiss it. A click anywhere else still does.
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
			onHoverRelease();
		};
		window.addEventListener("mouseup", onMouseUp);
		window.addEventListener("mousedown", onMouseDown);
		return () => {
			window.removeEventListener("mouseup", onMouseUp);
			window.removeEventListener("mousedown", onMouseDown);
		};
	}, [onHoverRelease]);

	useLayoutEffect(() => {
		const update = () => {
			if (!anchor.isConnected) {
				onHoverRelease();
				return;
			}
			// A new DOMRect is always a new state value. Setting it on every
			// pass retriggers this effect and overflows React's update depth.
			const next = anchor.getBoundingClientRect();
			setRect((prev) => (clientRectMoved(prev, next) ? next : prev));
		};
		update();
		window.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);
		return () => {
			window.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
		};
	}, [anchor, onHoverRelease]);
	useEffect(() => {
		if (!anchor.isConnected) onHoverRelease();
	});

	const placeBelow = rect.top < 320;
	if (typeof document === "undefined") return null;
	const position = placeAnchoredPopover(rect, {
		width: remToPx(24),
		viewportWidth: window.innerWidth,
		placeBelow,
	});
	const source = selectionSourceLabel(selection, labelForPath, paperPaths, t);
	const page = selection.page
		? t("composer.visualAnnotationPage", { page: selection.page })
		: null;
	return createPortal(
		// Hover bridge into the card; the quote stays selectable.
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer bridge so the quote can be read and copied between the reference and its card
		<div
			ref={cardRef}
			data-annotation-ui
			className="fixed z-50"
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
			{/* Material arrives from the anchor: fade + scale, no overshoot. */}
			<div
				className={cn(
					"agentero-scroll max-h-[min(24rem,calc(100vh-2rem))] overflow-y-auto rounded-xl bg-popover/95 p-4 text-popover-foreground shadow-overlay ring-1 ring-foreground/10 backdrop-blur-md",
					placeBelow ? "origin-top" : "origin-bottom",
					"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150 motion-safe:ease-out motion-reduce:animate-none",
				)}
			>
				<header className="flex items-baseline justify-between gap-3">
					<p
						className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground leading-4 tracking-[0.01em]"
						title={page ? `${source} · ${page}` : source}
					>
						{source}
					</p>
					{page ? (
						<span className="shrink-0 text-[11px] text-muted-foreground/70 leading-4 tabular-nums">
							{page}
						</span>
					) : null}
				</header>
				<p
					data-annotation-selectable
					className="mt-2.5 whitespace-pre-wrap break-words text-[13px] text-foreground leading-[1.6] select-text"
				>
					{selection.text}
				</p>
				{translation ? (
					<p className="mt-2.5 whitespace-pre-wrap break-words text-muted-foreground text-xs leading-relaxed select-text">
						<span className="font-medium">
							{t("transcript.annotationTranslation")}
						</span>
						{": "}
						{translation}
					</p>
				) : null}
			</div>
		</div>,
		document.body,
	);
}

/** Saved translation for the quote, if the paper carries one. */
function useSelectionTranslation(selection: SelectionContext): string | null {
	const paperAbs =
		selection.origin === "pdf" ? (selection.paperAbsPath?.trim() ?? "") : "";
	const requestKey = `${paperAbs}\n${selection.text}`;
	const [loaded, setLoaded] = useState<{
		key: string;
		translation: string | null;
	} | null>(null);
	useEffect(() => {
		if (!paperAbs) return;
		let cancelled = false;
		void readAnnotationTranslation(paperAbs, selection.text).then(
			(translation) => {
				if (cancelled) return;
				setLoaded({ key: requestKey, translation });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [paperAbs, requestKey, selection.text]);
	return loaded?.key === requestKey ? loaded.translation : null;
}
