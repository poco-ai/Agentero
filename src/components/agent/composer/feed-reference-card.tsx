/**
 * Hover preview for a Plaza feed reference chip in the Agent composer.
 *
 * Mirrors the text / visual reference cards: hovering the chip opens this
 * card, the chip itself opens the item's detail page on click, and removal
 * only happens through the header button (or Backspace inside the input).
 * Content comes from the already-registered plaza mention entry, so the card
 * never fetches anything.
 */

import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	placeAnchoredPopover,
	remToPx,
} from "@/components/agent/composer/anchored-popover";
import { clientRectMoved } from "@/components/agent/composer/composer-annotations";
import { Button } from "@/components/ui/button";
import { lookupPlazaMention } from "@/lib/agent/plaza-mention";
import { formatFeedWhen } from "@/lib/plaza/feeds";

export function FeedReferenceCard({
	path,
	anchor,
	onHoverHold,
	onHoverRelease,
	onRemove,
}: {
	path: string;
	anchor: HTMLElement;
	onHoverHold: () => void;
	onHoverRelease: () => void;
	onRemove: (path: string) => void;
}) {
	const { t, i18n } = useTranslation(["agent", "common"]);
	const [rect, setRect] = useState(() => anchor.getBoundingClientRect());

	useLayoutEffect(() => {
		const update = () => {
			if (!anchor.isConnected) {
				onHoverRelease();
				return;
			}
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
	const entry = lookupPlazaMention(path);
	const title = entry?.title.trim() || path;
	const when = formatFeedWhen(entry?.publishedAt ?? null, i18n.language);
	const meta = [entry?.sourceLabel, when].filter(Boolean).join(" · ");

	return createPortal(
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer bridge so the card stays open between the chip and its remove button
		<div
			data-annotation-ui
			className="fixed z-50 max-h-[min(24rem,calc(100vh-2rem))] overflow-y-auto rounded-lg bg-popover p-2.5 text-popover-foreground text-sm shadow-overlay ring-1 ring-foreground/10"
			style={{
				left: position.left,
				top: position.top,
				width: position.width,
				transform: position.transform,
			}}
			onMouseEnter={onHoverHold}
			onMouseLeave={onHoverRelease}
			onMouseDown={(event) => {
				const target = event.target as HTMLElement | null;
				if (target?.closest("button, a, input, textarea")) return;
				event.preventDefault();
			}}
		>
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<div className="line-clamp-2 font-medium leading-snug">{title}</div>
					{meta ? (
						<div className="mt-0.5 truncate text-muted-foreground text-xs">
							{meta}
						</div>
					) : null}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("common:remove")}
					onClick={() => {
						onRemove(path);
						onHoverRelease();
					}}
				>
					<X className="size-3.5" aria-hidden />
				</Button>
			</div>
			{entry?.abstract ? (
				<p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground text-xs leading-relaxed">
					{entry.abstract}
				</p>
			) : null}
		</div>,
		document.body,
	);
}
