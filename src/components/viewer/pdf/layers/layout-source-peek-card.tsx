/**
 * Read-only source card for a middle-clicked translated block.
 *
 * Shows the English text of the clicked block and its reading-order neighbours,
 * with the sentence the pointer rested on tinted. It never translates or writes
 * anything, so it also works offline; scrolling, zooming, page turns, Escape
 * and a click elsewhere close it. Rendered in a body portal so the reading
 * viewport's clipping and stacking cannot hide it.
 */

import { Languages, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import { cn } from "@/lib/core/utils";
import type {
	LayoutSourcePeekBlock,
	LayoutSourceSentenceRange,
} from "@/lib/pdf/layout/source-peek";

/** Wide enough for a full English line, narrow enough to leave the page visible. */
const CARD_WIDTH = 420;
/** Preferred max height; the body scrolls when a block's neighbours are long. */
const CARD_HEIGHT = 440;

export type LayoutSourcePeekState = {
	anchor: { x: number; y: number };
	blocks: readonly LayoutSourcePeekBlock[];
	clickedIndex: number;
	/** Clicked sentence inside the clicked block, when the block has pairs. */
	range: LayoutSourceSentenceRange | null;
};

export function LayoutSourcePeekCard({
	anchor,
	blocks,
	clickedIndex,
	range,
	onClose,
}: LayoutSourcePeekState & { onClose: () => void }) {
	const { t } = useTranslation("viewer");
	const rootRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	// The reader dismisses the card by leaving it behind: scrolling or zooming
	// the page (wheel / trackpad / scrollbar), or resizing the window. Scrolling
	// inside the card's own body keeps it open.
	const isInside = useCallback(
		(target: EventTarget | null) =>
			target instanceof Node && Boolean(rootRef.current?.contains(target)),
		[],
	);
	useEffect(() => {
		const closeOutside = (event: Event) => {
			if (isInside(event.target)) return;
			closeRef.current();
		};
		const onScroll = (event: Event) => {
			// A scroll inside the card body is the reader moving through the
			// card, not the page moving away from the click.
			if (isInside(event.target)) return;
			closeRef.current();
		};
		const onResize = () => closeRef.current();
		window.addEventListener("wheel", closeOutside, {
			capture: true,
			passive: true,
		});
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("wheel", closeOutside, true);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
		};
	}, [isInside]);

	return createPortal(
		<div ref={rootRef}>
			<SelectionCard
				screen={anchor}
				width={CARD_WIDTH}
				height={CARD_HEIGHT}
				trackPin
				title={t("pdf.viewMode.original")}
				icon={<Languages />}
				actions={[
					{
						id: "close",
						label: t("pdf.layoutTranslate.close"),
						icon: <X />,
						onClick: onClose,
					},
				]}
				onDismiss={onClose}
				bodyClassName="select-text"
			>
				<div className="divide-y divide-border/60">
					{blocks.map((block, index) => {
						const clicked = index === clickedIndex;
						return (
							<div
								key={block.id}
								className={cn(
									"relative px-3 py-2.5",
									clicked && "bg-primary/[0.06]",
								)}
							>
								{clicked ? (
									<span
										aria-hidden="true"
										className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary"
									/>
								) : null}
								<p
									className={cn(
										"m-0 whitespace-pre-wrap text-[12.5px] leading-relaxed",
										clicked ? "text-foreground" : "text-foreground/75",
									)}
								>
									{clicked && range ? (
										<>
											{block.source.slice(0, range.start)}
											<mark className="rounded-[2px] bg-amber-200/70 px-0.5 text-foreground dark:bg-amber-300/25">
												{block.source.slice(range.start, range.end)}
											</mark>
											{block.source.slice(range.end)}
										</>
									) : (
										block.source
									)}
								</p>
							</div>
						);
					})}
				</div>
			</SelectionCard>
		</div>,
		document.body,
	);
}
