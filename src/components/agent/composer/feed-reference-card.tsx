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
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	placeAnchoredPopover,
	remToPx,
} from "@/components/agent/composer/anchored-popover";
import { clientRectMoved } from "@/components/agent/composer/composer-annotations";
import { MessageResponse } from "@/components/agent/message";
import { Button } from "@/components/ui/button";
import { lookupPlazaMention } from "@/lib/agent/plaza-mention";
import { formatFeedWhen } from "@/lib/plaza/feeds";

/** Streamdown/typography defaults are chat-sized; the card is a 24rem preview. */
const EXCERPT_CLASS =
	"prose prose-sm dark:prose-invert mt-2 max-w-none break-words leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:mt-1 [&_h1]:mb-1 [&_h1]:font-medium [&_h1]:text-sm [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:font-medium [&_h2]:text-sm [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-medium [&_h3]:text-xs [&_h4]:mt-2 [&_h4]:mb-1 [&_h4]:text-xs [&_p]:my-1 [&_ul]:my-1 [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:pl-4 [&_li]:my-0 [&_pre]:my-1 [&_pre]:text-[0.7rem] [&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_a]:underline";

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
	const cardRef = useRef<HTMLDivElement>(null);
	const hoveringRef = useRef(false);
	const selectingRef = useRef(false);

	/** A live, non-collapsed selection anchored inside the card. */
	const selectionInsideCard = useCallback(() => {
		const card = cardRef.current;
		const selection =
			typeof document.getSelection === "function"
				? document.getSelection()
				: null;
		const node = selection?.anchorNode;
		return Boolean(
			card &&
				selection &&
				!selection.isCollapsed &&
				node &&
				card.contains(node),
		);
	}, []);

	// Selecting the preview is a normal reading gesture: releasing outside the
	// card must not dismiss it. A click anywhere else still does.
	useEffect(() => {
		const onMouseUp = () => {
			if (!selectingRef.current) return;
			selectingRef.current = false;
			if (hoveringRef.current || selectionInsideCard()) return;
			onHoverRelease();
		};
		const onMouseDown = (event: MouseEvent) => {
			const card = cardRef.current;
			if (!card) return;
			if (event.target instanceof Node && card.contains(event.target)) return;
			onHoverRelease();
		};
		window.addEventListener("mouseup", onMouseUp);
		window.addEventListener("mousedown", onMouseDown);
		return () => {
			window.removeEventListener("mouseup", onMouseUp);
			window.removeEventListener("mousedown", onMouseDown);
		};
	}, [onHoverRelease, selectionInsideCard]);

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
			ref={cardRef}
			data-annotation-ui
			className="fixed z-50 max-h-[min(24rem,calc(100vh-2rem))] select-text overflow-y-auto rounded-lg bg-popover p-2.5 text-popover-foreground text-sm shadow-overlay ring-1 ring-foreground/10"
			style={{
				left: position.left,
				top: position.top,
				width: position.width,
				transform: position.transform,
				// Tailwind's select-text may skip the prefix on older WebKit.
				WebkitUserSelect: "text",
				userSelect: "text",
			}}
			onMouseEnter={() => {
				hoveringRef.current = true;
				onHoverHold();
			}}
			onMouseLeave={() => {
				hoveringRef.current = false;
				if (selectingRef.current || selectionInsideCard()) return;
				onHoverRelease();
			}}
			onMouseDown={(event) => {
				const target = event.target as HTMLElement | null;
				if (target?.closest("button, a, input, textarea")) return;
				selectingRef.current = true;
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
				<MessageResponse className={EXCERPT_CLASS}>
					{entry.abstract}
				</MessageResponse>
			) : null}
		</div>,
		document.body,
	);
}
