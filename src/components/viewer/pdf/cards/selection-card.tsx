import { GripHorizontal } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Dialog } from "radix-ui";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PDF_FLOAT_CARD } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import type { CardScreenPoint } from "@/components/viewer/pdf/types";
import { clamp } from "@/lib/core/math";
import { cn } from "@/lib/core/utils";
import {
	readPdfCardWidth,
	watchCardWidthResize,
	writePdfCardWidth,
} from "@/lib/pdf/card-size";
import { useSelectionOverlayGuard } from "@/lib/workspace/selection-overlay";

/** Minimum inset from the viewport edges (px). */
export const SELECTION_CARD_EDGE = 12;
/** Gap between a text-selection box and its card (px). */
const SELECTION_ANCHOR_GAP = 8;
/** Default preferred max height when callers omit `height` (px). */
const SELECTION_CARD_DEFAULT_MAX_HEIGHT = 420;
/** Floor so a clipped card remains usable on short viewports (px). */
const SELECTION_CARD_MIN_HEIGHT = 120;
const RESIZE_MIN_WIDTH = 280;
const RESIZE_MIN_HEIGHT = 200;

type SelectionCardAction = {
	/** Stable identity for actions whose label changes. */
	id?: string;
	label: string;
	onClick: () => void;
	icon: ReactNode;
	/** Destructive styling for the header icon button */
	destructive?: boolean;
	/** Pressed state for toggle actions such as pin / unpin. */
	pressed?: boolean;
	shortcut?: string;
};

type PlaceSelectionCardOptions = {
	/** Preferred card width used for edge-flip (px). */
	width: number;
	/** Preferred max height; clamped to remaining viewport (px). */
	height?: number;
	/**
	 * Width used only for side choice + horizontal clamp (px).
	 * Pass the largest size the card may grow to so compact → expanded
	 * does not flip sides and thrash under the pointer.
	 */
	placementWidth?: number;
	/**
	 * Height used only for vertical position planning (px).
	 * Pass the largest size the card may grow to so expand does not jump.
	 */
	placementHeight?: number;
	/**
	 * Stick near the anchor on the Y axis and shrink maxHeight instead of
	 * pre-shifting the card as if it were already full height. Use for
	 * content-sized cards (e.g. translate) so they track scroll/pin moves.
	 */
	trackPin?: boolean;
	/** Open to the right of the anchor when there is room (default true). */
	preferRight?: boolean;
	/**
	 * Open below the selected lines instead of above. Translation cards use
	 * this so the result never covers the text the reader just selected.
	 */
	preferBelow?: boolean;
	/** Gap from the anchor point (default 4). */
	gap?: number;
	/** The rendered height, used to align a card above a selection. */
	contentHeight?: number;
	/**
	 * Screen-space rect that placement must stay inside (defaults to the
	 * window). Page-anchored PDF cards pass the reading viewport so they never
	 * open over the tab strip or the viewer toolbars.
	 */
	container?: { left: number; top: number; width: number; height: number };
};

type PlaceSelectionCardResult = {
	left: number;
	top: number;
	/** Dynamic max height so the card never extends past the viewport. */
	maxHeight: number;
};

/**
 * Shared viewport placement for PDF selection popovers
 * (ask / translate / annotate).
 *
 * Clamps left/top and returns a `maxHeight` that fits within the viewport
 * from the chosen top — callers must apply it so tall content scrolls
 * instead of overflowing the window.
 *
 * When `placementWidth` / `placementHeight` are set, position is planned for
 * that larger footprint while `width` / `height` still drive the returned
 * visual max height. Compact previews that later expand stay on one side.
 */
export function placeSelectionCard(
	screen: CardScreenPoint,
	opts: PlaceSelectionCardOptions,
): PlaceSelectionCardResult {
	const preferredWidth = opts.width;
	const preferredMaxH = opts.height ?? SELECTION_CARD_DEFAULT_MAX_HEIGHT;
	const gap = opts.gap ?? 4;
	const preferRight = opts.preferRight ?? true;
	const trackPin = opts.trackPin ?? false;
	const edge = SELECTION_CARD_EDGE;
	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	// Placement bounds: the window by default, the reading area when the card
	// is clipped to a PDF scroller.
	const minX = (opts.container?.left ?? 0) + edge;
	const minY = (opts.container?.top ?? 0) + edge;
	const maxX =
		(opts.container ? opts.container.left + opts.container.width : vw) - edge;
	const maxY =
		(opts.container ? opts.container.top + opts.container.height : vh) - edge;

	if (screen.selectionBounds) {
		const bounds = screen.selectionBounds;
		const gap = SELECTION_ANCHOR_GAP;
		const usableHeight = Math.max(0, maxY - minY);
		const minHeight = Math.min(SELECTION_CARD_MIN_HEIGHT, usableHeight);
		const upperEdge = clamp(bounds.top - gap, minY, minY + usableHeight);
		const lowerEdge = clamp(bounds.bottom + gap, minY, minY + usableHeight);
		const above = upperEdge - minY;
		const below = minY + usableHeight - lowerEdge;
		const left = clamp(
			screen.x - preferredWidth / 2,
			minX,
			Math.max(minX, maxX - preferredWidth),
		);

		if (above < minHeight && below < minHeight) {
			const leftSpace = bounds.left - gap - minX;
			const rightSpace = maxX - bounds.right - gap;
			if (Math.max(leftSpace, rightSpace) >= preferredWidth) {
				const maxHeight = Math.min(preferredMaxH, usableHeight);
				return {
					left:
						rightSpace >= leftSpace
							? bounds.right + gap
							: bounds.left - gap - preferredWidth,
					top: clamp(bounds.top, minY, minY + usableHeight - maxHeight),
					maxHeight,
				};
			}
		}

		const openAbove = () => {
			const maxHeight = Math.min(preferredMaxH, Math.max(minHeight, above));
			const contentHeight = Math.min(
				maxHeight,
				opts.contentHeight ?? minHeight,
			);
			return {
				left,
				top: Math.max(minY, upperEdge - contentHeight),
				maxHeight,
			};
		};
		const openBelow = (fillMinimum: boolean) => {
			const height = fillMinimum ? Math.max(minHeight, below) : below;
			return {
				left,
				top: fillMinimum
					? Math.min(lowerEdge, minY + usableHeight - minHeight)
					: lowerEdge,
				maxHeight: Math.min(preferredMaxH, Math.max(0, height)),
			};
		};

		if (opts.preferBelow) {
			if (below >= minHeight || above < minHeight) return openBelow(false);
			return openAbove();
		}

		if (above >= minHeight || (below < minHeight && above >= below)) {
			return openAbove();
		}
		return openBelow(true);
	}

	// Layout footprint for flip/clamp (stable across compact → expanded).
	const planWidth = Math.min(
		opts.placementWidth ?? preferredWidth,
		Math.max(0, maxX - minX),
	);
	const planHeight = Math.min(
		opts.placementHeight ?? preferredMaxH,
		Math.max(0, maxY - minY),
	);

	// Prefer the pin's side: right of anchor, or fully to the left of it.
	let left = preferRight ? screen.x + gap : screen.x - planWidth - gap;
	if (preferRight && left + planWidth > maxX) {
		// Not enough room on the right — flip left of the pin.
		left = Math.max(minX, screen.x - planWidth - gap);
	} else if (!preferRight && left < minX) {
		// Not enough room on the left — flip right of the pin.
		left = Math.min(maxX - planWidth, screen.x + gap);
	}
	left = clamp(left, minX, Math.max(minX, maxX - planWidth));

	const viewportCap = Math.max(SELECTION_CARD_MIN_HEIGHT, maxY - minY);

	if (trackPin) {
		// Content-sized cards: follow the pin; shrink maxHeight near edges
		// instead of pre-shifting top by the full preferred height.
		let top = screen.y - 8;
		if (top < minY) top = minY;
		let maxHeight = Math.min(preferredMaxH, viewportCap, maxY - top);
		if (
			maxHeight < SELECTION_CARD_MIN_HEIGHT &&
			maxY - minY >= SELECTION_CARD_MIN_HEIGHT
		) {
			// Not enough room below the pin — slide up just enough to fit.
			maxHeight = Math.min(preferredMaxH, viewportCap);
			top = Math.max(minY, maxY - maxHeight);
			maxHeight = Math.min(maxHeight, maxY - top);
		}
		return { left, top, maxHeight: Math.max(0, maxHeight) };
	}

	// Plan top against the largest height so expand does not re-anchor.
	// Keep the card top near the pin; only slide up when it would overflow.
	const plannedMaxH = Math.min(planHeight, viewportCap);
	let top = screen.y - 8;
	if (top + plannedMaxH > maxY) {
		top = maxY - plannedMaxH;
	}
	if (top < minY) {
		top = minY;
	}

	// Visual max height still follows the caller's current preferred height.
	let maxHeight = Math.min(preferredMaxH, viewportCap, maxY - top);
	if (
		maxHeight < SELECTION_CARD_MIN_HEIGHT &&
		maxY - minY >= SELECTION_CARD_MIN_HEIGHT
	) {
		// Prefer min usable height by sliding further up when possible.
		maxHeight = SELECTION_CARD_MIN_HEIGHT;
		top = Math.max(minY, maxY - maxHeight);
		maxHeight = Math.min(maxHeight, maxY - top);
	}
	maxHeight = Math.max(0, maxHeight);

	return { left, top, maxHeight };
}

type SelectionCardProps = {
	screen: CardScreenPoint;
	/** Visual width class / clamp target (px number for placement). */
	width?: number;
	/** Preferred max height; actual height is min(this, viewport remainder). */
	height?: number;
	/**
	 * Optional larger width used only for side choice (see placeSelectionCard).
	 * Useful for compact → expanded hover cards.
	 */
	placementWidth?: number;
	/**
	 * Optional larger height used only for vertical position planning.
	 */
	placementHeight?: number;
	/**
	 * Follow the anchor on scroll (content-sized cards). See placeSelectionCard.
	 */
	trackPin?: boolean;
	/**
	 * Pin the card to the computed max height (not content-sized).
	 * Needed when the body hosts StickToBottom / `height: 100%` scrollers
	 * (e.g. PDF Ask conversation) so the scrollbar has a definite viewport.
	 */
	lockHeight?: boolean;
	/** Allow native corner resizing within the available viewport. */
	resizable?: boolean;
	/** Minimum native resize width (px). Defaults to 280. */
	resizeMinWidth?: number;
	/** Minimum native resize height (px). Defaults to 200. */
	resizeMinHeight?: number;
	/**
	 * Design/content cap for horizontal resizing (px). Omit to use the viewport
	 * room; prose cards pass their reading width so lines never grow unbounded.
	 */
	resizeMaxWidth?: number;
	/**
	 * Remember the width the user drags the native resize corner to under this
	 * kind key, and open the next card of the same kind at that width. Height
	 * stays content-sized, so a short result keeps hugging its text.
	 */
	rememberWidth?: string;
	/** Allow repositioning from the title. */
	draggable?: boolean;
	/** Show the centered grip glyph in a draggable header (default true). */
	showDragHandle?: boolean;
	/**
	 * When false, the body does not scroll (`agentero-scroll` off) and grows
	 * with content. Use for short tables that should show fully (formula legend).
	 * Still clamped by placement `maxHeight` via the outer shell when needed.
	 */
	bodyScroll?: boolean;
	preferRight?: boolean;
	/** Open below the selected lines instead of above (translation cards). */
	preferBelow?: boolean;
	/** Extra header classes, e.g. tighter padding for the translation card. */
	headerClassName?: string;
	title: string;
	/** Optional header glyph; omit for a title-only header. */
	icon?: ReactNode;
	/** Header trailing icon buttons (close / hide / delete …). */
	actions?: SelectionCardAction[];
	/** Accessible name; defaults to title. */
	ariaLabel?: string;
	/** Announce body updates (e.g. streaming translation). */
	ariaLive?: "polite" | "off";
	/** Dismiss this card on Escape or pointer interaction outside it. */
	onDismiss?: () => void;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
	/** Optional footer strip (prompt input, save/cancel). */
	footer?: ReactNode;
	className?: string;
	bodyClassName?: string;
	children: ReactNode;
};

/**
 * Shared floating card chrome for PDF selection workflows:
 * Ask / Translate / Annotate. Same shell, different body/footer.
 *
 * Always viewport-bounded: `maxHeight` from placement + body scroll
 * (or nested scroller when `lockHeight` + `overflow-hidden` body).
 */
export function SelectionCard({
	screen,
	width = 320,
	height = SELECTION_CARD_DEFAULT_MAX_HEIGHT,
	placementWidth,
	placementHeight,
	trackPin = false,
	lockHeight = false,
	resizable = false,
	resizeMinWidth = RESIZE_MIN_WIDTH,
	resizeMinHeight = RESIZE_MIN_HEIGHT,
	resizeMaxWidth,
	rememberWidth,
	draggable = false,
	showDragHandle = true,
	bodyScroll = true,
	preferRight = true,
	preferBelow = false,
	headerClassName,
	title,
	icon,
	actions,
	ariaLabel,
	ariaLive = "off",
	onDismiss,
	onPointerEnter,
	onPointerLeave,
	footer,
	className,
	bodyClassName,
	children,
}: SelectionCardProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	/** Manual placement relative to the page anchor or the viewport origin. */
	const [offset, setOffset] = useState<{ dx: number; dy: number }>();
	const screenRef = useRef(screen);
	screenRef.current = screen;
	const [contentHeight, setContentHeight] = useState<number>();
	const dragRef = useRef<{
		pointerId: number;
		x: number;
		y: number;
		anchorX: number;
		anchorY: number;
	} | null>(null);
	/** Width from the previous card of this kind, applied once at mount. */
	const [rememberedWidth] = useState<number | null>(() =>
		rememberWidth ? readPdfCardWidth(rememberWidth) : null,
	);
	const reduceMotion = useReducedMotion();
	const [viewport, setViewport] = useState(() => ({
		width: typeof window !== "undefined" ? window.innerWidth : 1200,
		height: typeof window !== "undefined" ? window.innerHeight : 800,
	}));
	useEffect(() => {
		if (!resizable && !draggable) return;
		const resize = () =>
			setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, [resizable, draggable]);
	// Suspend dockview drag-and-drop while this card floats over the tab strip
	// so a stray drag cannot split the layout (#608).
	useSelectionOverlayGuard();
	// CSS `resize: both` only writes inline width/height and fires no event;
	// remember a settled drag so the next card of this kind reopens at that
	// width (height stays content-sized).
	useEffect(() => {
		const element = rootRef.current;
		if (!element || !resizable || !rememberWidth || lockHeight) return;
		return watchCardWidthResize(element, (width) => {
			writePdfCardWidth(rememberWidth, width);
		});
	}, [lockHeight, rememberWidth, resizable]);
	// Floating controls keep their UI size while the document is zoomed.
	// Placement still clamps each card within the current viewport.
	const viewportWidth =
		resizable || draggable
			? viewport.width
			: typeof window !== "undefined"
				? window.innerWidth
				: 1200;
	/**
	 * Page-anchored cards are clipped to the reading viewport (see
	 * `clipInset`). Placement and dragging stay inside that same rect so the
	 * card never opens or moves over the tab strip / toolbars.
	 */
	const container = screen.clipInset
		? {
				left: screen.clipInset.left,
				top: screen.clipInset.top,
				width: Math.max(
					0,
					viewport.width - screen.clipInset.left - screen.clipInset.right,
				),
				height: Math.max(
					0,
					viewport.height - screen.clipInset.top - screen.clipInset.bottom,
				),
			}
		: undefined;
	const preferredWidth = rememberedWidth
		? Math.min(rememberedWidth, resizeMaxWidth ?? Infinity)
		: width;
	const renderedWidth = Math.min(
		preferredWidth,
		Math.max(0, viewportWidth - SELECTION_CARD_EDGE * 2),
	);
	const anchor = placeSelectionCard(screen, {
		width: renderedWidth,
		// Page-anchored cards may use the whole reading area; short results still
		// hug their content, long ones no longer stop at a fixed 480px cap.
		height: container ? Math.max(height, container.height) : height,
		placementWidth: placementWidth
			? Math.min(
					placementWidth,
					Math.max(0, viewportWidth - SELECTION_CARD_EDGE * 2),
				)
			: undefined,
		placementHeight,
		trackPin,
		preferRight,
		preferBelow,
		contentHeight,
		container,
	});
	const selectionBounds = screen.selectionBounds;
	const followsPage = Boolean(selectionBounds);
	const dragOriginX = followsPage ? screen.x : 0;
	const dragOriginY = followsPage ? screen.y : 0;
	/**
	 * Freeze the placement a page-anchored card received when it opened, then
	 * track the text: side, horizontal offset and height cap stay put while the
	 * card follows the page. Re-running the viewport clamp on every scroll tick
	 * would pin the card to the top edge instead of scrolling it out.
	 */
	const trackRef = useRef<{
		side: "above" | "below";
		dx: number;
		maxHeight: number;
	} | null>(null);
	if (!trackRef.current && selectionBounds) {
		trackRef.current = {
			side: anchor.top < selectionBounds.top ? "above" : "below",
			dx: anchor.left - screen.x,
			maxHeight: anchor.maxHeight,
		};
	}
	const track = trackRef.current;
	const anchoredToSelection = followsPage && !offset;
	useLayoutEffect(() => {
		const card = rootRef.current;
		if (!anchoredToSelection || !card) return;
		const measure = () => {
			const rect = card.getBoundingClientRect();
			if (resizable && !lockHeight && card.style.height) {
				// Native corner resizing takes over from the initial anchor, but
				// keeps tracking the page through the stored anchor offset.
				setOffset({
					dx: rect.left - screenRef.current.x,
					dy: rect.top - screenRef.current.y,
				});
			} else {
				setContentHeight(rect.height);
			}
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(card);
		return () => observer.disconnect();
	}, [anchoredToSelection, lockHeight, resizable]);
	const edge = SELECTION_CARD_EDGE;
	const boundLeft = (container?.left ?? 0) + edge;
	const boundTop = (container?.top ?? 0) + edge;
	const boundRight =
		(container ? container.left + container.width : viewport.width) - edge;
	const boundBottom =
		(container ? container.top + container.height : viewport.height) - edge;
	const rawLeft = offset
		? dragOriginX + offset.dx
		: track
			? screen.x + track.dx
			: null;
	const left =
		rawLeft == null
			? anchor.left
			: followsPage
				? rawLeft
				: clamp(
						rawLeft,
						boundLeft,
						Math.max(
							boundLeft,
							boundRight - (resizable ? RESIZE_MIN_WIDTH : renderedWidth),
						),
					);
	const rawTop = offset
		? dragOriginY + offset.dy
		: track && selectionBounds
			? track.side === "above"
				? contentHeight != null
					? selectionBounds.top - SELECTION_ANCHOR_GAP - contentHeight
					: anchor.top
				: selectionBounds.bottom + SELECTION_ANCHOR_GAP
			: null;
	const top =
		rawTop == null
			? anchor.top
			: followsPage
				? rawTop
				: clamp(
						rawTop,
						boundTop,
						Math.max(boundTop, boundBottom - SELECTION_CARD_MIN_HEIGHT),
					);
	const maxHeight = track
		? Math.min(
				track.maxHeight,
				Math.max(SELECTION_CARD_MIN_HEIGHT, boundBottom - boundTop),
			)
		: anchor.maxHeight;
	const resizeRoomWidth = Math.max(0, boundRight - left);
	const resizeRoomHeight = Math.min(
		anchoredToSelection ? maxHeight : Infinity,
		Math.max(0, boundBottom - top),
	);
	const resizeWidthCap =
		resizeMaxWidth !== undefined && Number.isFinite(resizeMaxWidth)
			? Math.min(resizeRoomWidth, Math.max(0, resizeMaxWidth))
			: resizeRoomWidth;
	// Locked cards use the placement cap while anchored; after a drag, shrink
	// to the room below the new top so a short window does not overflow. Cards
	// that follow the page keep their cap so scrolling never compresses them.
	const cardMaxHeight =
		offset && !followsPage ? Math.min(height, resizeRoomHeight) : maxHeight;
	// The gutter pin sits on the side the card opens toward. Reveal the card
	// from that corner so it looks like the pin expands into the full card.
	const isRightSide = anchor.left + renderedWidth / 2 >= screen.x;
	const originClip = isRightSide
		? "inset(0 100% 100% 0)"
		: "inset(0 0 100% 100%)";
	const transition = reduceMotion
		? { duration: 0 }
		: { type: "spring" as const, bounce: 0, duration: 0.35 };
	const titleNode = (
		<span className="min-w-0 flex-1 truncate font-semibold text-[13px] text-foreground tracking-[-0.01em]">
			{title}
		</span>
	);

	const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
		if (event.target instanceof Element && event.target.closest("button"))
			return;
		const rect = rootRef.current?.getBoundingClientRect();
		if (!rect || event.button !== 0 || dragRef.current) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			pointerId: event.pointerId,
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
			anchorX: dragOriginX,
			anchorY: dragOriginY,
		};
	};

	const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const rect = rootRef.current?.getBoundingClientRect();
		if (!rect) return;
		const left = clamp(
			event.clientX - drag.x,
			boundLeft,
			Math.max(boundLeft, boundRight - rect.width),
		);
		const top = clamp(
			event.clientY - drag.y,
			boundTop,
			Math.max(boundTop, boundBottom - rect.height),
		);
		setOffset({ dx: left - drag.anchorX, dy: top - drag.anchorY });
	};

	// If the card mounts / remounts under an existing pointer (mode switch,
	// open under cursor), browsers do not re-fire pointerenter — re-arm the
	// parent hover surface so hide timers do not close an actively hovered modal.
	useEffect(() => {
		const el = rootRef.current;
		if (!el || !onPointerEnter) return;
		if (el.matches(":hover")) onPointerEnter();
	}, [onPointerEnter]);

	const handlePointerLeave = (e: ReactPointerEvent<HTMLDivElement>) => {
		// Still inside this card (including children) — ignore.
		const next = e.relatedTarget;
		if (next instanceof Node && e.currentTarget.contains(next)) return;
		onPointerLeave?.();
	};

	const card = (
		<motion.div
			ref={rootRef}
			className={cn(
				"fixed z-50 flex flex-col",
				// Content-sized cards (no body scroll) should not clip children.
				bodyScroll || lockHeight ? "overflow-hidden" : "overflow-visible",
				PDF_FLOAT_CARD,
				className,
			)}
			initial={{ clipPath: originClip }}
			animate={{ clipPath: "inset(0 0 0 0)" }}
			exit={{ clipPath: originClip }}
			transition={transition}
			style={{
				left,
				top,
				width: renderedWidth,
				// Only enforce maxHeight when the body is a scroller / locked;
				// content-sized cards grow with their children (viewport clamp is
				// still applied via placeSelectionCard when height is large).
				...(bodyScroll || lockHeight
					? {
							maxHeight: cardMaxHeight,
						}
					: null),
				// Definite height so flex-1 + nested height:100% scroll areas work.
				...(lockHeight ? { height: cardMaxHeight } : null),
				...(resizable
					? {
							resize: "both",
							minWidth: Math.min(resizeMinWidth, resizeWidthCap),
							minHeight: Math.min(resizeMinHeight, resizeRoomHeight),
							maxWidth: resizeWidthCap,
							maxHeight: resizeRoomHeight,
						}
					: null),
			}}
			role="dialog"
			aria-label={ariaLabel ?? title}
			aria-modal="false"
			onMouseDown={(e) => e.stopPropagation()}
			// Prefer pointer events so PDF hit targets (pointerenter/leave) and
			// floating cards share the same hover model — mouse-only leave can
			// race with pointer leave on some trackpads and flicker hide timers.
			onPointerEnter={onPointerEnter}
			onPointerLeave={handlePointerLeave}
		>
			<header
				className={cn(
					"relative flex shrink-0 items-center gap-2 border-border/50 border-b px-3 py-1.5",
					draggable &&
						"touch-none select-none cursor-grab active:cursor-grabbing",
					draggable && showDragHandle && "pt-2",
					headerClassName,
				)}
				onPointerDown={draggable ? startDrag : undefined}
				onPointerMove={draggable ? moveDrag : undefined}
				onLostPointerCapture={() => {
					dragRef.current = null;
				}}
			>
				{draggable && showDragHandle ? (
					<GripHorizontal
						className="pointer-events-none absolute top-0.5 left-1/2 size-3.5 -translate-x-1/2 text-muted-foreground/70"
						aria-hidden
					/>
				) : null}
				{icon ? (
					<span
						className="shrink-0 text-muted-foreground [&_svg]:size-3.5"
						aria-hidden
					>
						{icon}
					</span>
				) : null}
				{onDismiss ? (
					<Dialog.Title asChild>{titleNode}</Dialog.Title>
				) : (
					titleNode
				)}
				{actions && actions.length > 0 ? (
					// disableHoverableContent: tooltip is portaled outside the card;
					// moving into it would fire pointerleave and start the hide timer.
					<TooltipProvider delayDuration={200} disableHoverableContent>
						<div className="flex items-center gap-0.5">
							{actions.map((a) => (
								<Tooltip key={a.id ?? a.label}>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-label={a.label}
											aria-pressed={a.pressed}
											aria-keyshortcuts={a.shortcut}
											// Native button (not ghost Button): avoid variant
											// hover:text-foreground fighting the red icon color.
											className={cn(
												"inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-md",
												"text-muted-foreground transition-colors outline-none",
												"focus-visible:ring-2 focus-visible:ring-ring/50",
												a.pressed
													? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
													: a.destructive
														? "hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
														: "hover:bg-muted hover:text-foreground",
											)}
											onClick={a.onClick}
										>
											<span
												className={cn(
													"inline-flex [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
													// currentColor so Lucide stroke follows hover:text-*
													"[&_svg]:text-current",
												)}
											>
												{a.icon}
											</span>
										</button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{a.label}
										{a.shortcut ? (
											<kbd className="ml-1.5 font-sans opacity-75">
												{a.shortcut === "Escape" ? "Esc" : a.shortcut}
											</kbd>
										) : null}
									</TooltipContent>
								</Tooltip>
							))}
						</div>
					</TooltipProvider>
				) : null}
			</header>

			<div
				className={cn(
					"flex flex-col",
					bodyScroll
						? "agentero-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
						: "overflow-visible",
					bodyClassName,
				)}
				aria-live={ariaLive === "off" ? undefined : ariaLive}
			>
				{children}
			</div>

			{footer ? (
				<div className="shrink-0 border-border/60 border-t p-2">{footer}</div>
			) : null}
		</motion.div>
	);

	if (onDismiss) {
		return (
			<Dialog.Root
				open
				modal={false}
				onOpenChange={(open) => {
					if (!open) onDismiss();
				}}
			>
				<Dialog.Content
					asChild
					aria-describedby={undefined}
					onOpenAutoFocus={(event) => event.preventDefault()}
					onCloseAutoFocus={(event) => event.preventDefault()}
				>
					{card}
				</Dialog.Content>
			</Dialog.Root>
		);
	}

	return card;
}
