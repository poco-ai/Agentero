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
import { useSelectionOverlayGuard } from "@/lib/workspace/selection-overlay";

/** Minimum inset from the viewport edges (px). */
export const SELECTION_CARD_EDGE = 12;
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

	if (screen.selectionBounds) {
		const bounds = screen.selectionBounds;
		const gap = 8;
		const usableHeight = Math.max(0, vh - edge * 2);
		const minHeight = Math.min(SELECTION_CARD_MIN_HEIGHT, usableHeight);
		const upperEdge = clamp(bounds.top - gap, edge, edge + usableHeight);
		const lowerEdge = clamp(bounds.bottom + gap, edge, edge + usableHeight);
		const above = upperEdge - edge;
		const below = edge + usableHeight - lowerEdge;
		const left = clamp(
			screen.x - preferredWidth / 2,
			edge,
			Math.max(edge, vw - edge - preferredWidth),
		);

		if (above < minHeight && below < minHeight) {
			const leftSpace = bounds.left - gap - edge;
			const rightSpace = vw - edge - bounds.right - gap;
			if (Math.max(leftSpace, rightSpace) >= preferredWidth) {
				const maxHeight = Math.min(preferredMaxH, usableHeight);
				return {
					left:
						rightSpace >= leftSpace
							? bounds.right + gap
							: bounds.left - gap - preferredWidth,
					top: clamp(bounds.top, edge, edge + usableHeight - maxHeight),
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
				top: Math.max(edge, upperEdge - contentHeight),
				maxHeight,
			};
		};
		const openBelow = (fillMinimum: boolean) => {
			const height = fillMinimum ? Math.max(minHeight, below) : below;
			return {
				left,
				top: fillMinimum
					? Math.min(lowerEdge, edge + usableHeight - minHeight)
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
		Math.max(0, vw - edge * 2),
	);
	const planHeight = Math.min(
		opts.placementHeight ?? preferredMaxH,
		Math.max(0, vh - edge * 2),
	);

	// Prefer the pin's side: right of anchor, or fully to the left of it.
	let left = preferRight ? screen.x + gap : screen.x - planWidth - gap;
	if (preferRight && left + planWidth > vw - edge) {
		// Not enough room on the right — flip left of the pin.
		left = Math.max(edge, screen.x - planWidth - gap);
	} else if (!preferRight && left < edge) {
		// Not enough room on the left — flip right of the pin.
		left = Math.min(vw - edge - planWidth, screen.x + gap);
	}
	left = clamp(left, edge, Math.max(edge, vw - planWidth - edge));

	const viewportCap = Math.max(SELECTION_CARD_MIN_HEIGHT, vh - edge * 2);

	if (trackPin) {
		// Content-sized cards: follow the pin; shrink maxHeight near edges
		// instead of pre-shifting top by the full preferred height.
		let top = screen.y - 8;
		if (top < edge) top = edge;
		let maxHeight = Math.min(preferredMaxH, viewportCap, vh - edge - top);
		if (
			maxHeight < SELECTION_CARD_MIN_HEIGHT &&
			vh - edge * 2 >= SELECTION_CARD_MIN_HEIGHT
		) {
			// Not enough room below the pin — slide up just enough to fit.
			maxHeight = Math.min(preferredMaxH, viewportCap);
			top = Math.max(edge, vh - edge - maxHeight);
			maxHeight = Math.min(maxHeight, vh - edge - top);
		}
		return { left, top, maxHeight: Math.max(0, maxHeight) };
	}

	// Plan top against the largest height so expand does not re-anchor.
	// Keep the card top near the pin; only slide up when it would overflow.
	const plannedMaxH = Math.min(planHeight, viewportCap);
	let top = screen.y - 8;
	if (top + plannedMaxH > vh - edge) {
		top = vh - edge - plannedMaxH;
	}
	if (top < edge) {
		top = edge;
	}

	// Visual max height still follows the caller's current preferred height.
	let maxHeight = Math.min(preferredMaxH, viewportCap, vh - edge - top);
	if (
		maxHeight < SELECTION_CARD_MIN_HEIGHT &&
		vh - edge * 2 >= SELECTION_CARD_MIN_HEIGHT
	) {
		// Prefer min usable height by sliding further up when possible.
		maxHeight = SELECTION_CARD_MIN_HEIGHT;
		top = Math.max(edge, vh - edge - maxHeight);
		maxHeight = Math.min(maxHeight, vh - edge - top);
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
	/** Minimum native corner-resize height (px). Defaults to 200. */
	resizeMinHeight?: number;
	/** Allow repositioning from the title, independently of the source anchor. */
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
	resizeMinHeight = RESIZE_MIN_HEIGHT,
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
	const [position, setPosition] = useState<{ left: number; top: number }>();
	const [contentHeight, setContentHeight] = useState<number>();
	const dragRef = useRef<{ pointerId: number; x: number; y: number }>(null);
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
	// Floating controls keep their UI size while the document is zoomed.
	// Placement still clamps each card within the current viewport.
	const viewportWidth =
		resizable || draggable
			? viewport.width
			: typeof window !== "undefined"
				? window.innerWidth
				: 1200;
	const renderedWidth = Math.min(
		width,
		Math.max(0, viewportWidth - SELECTION_CARD_EDGE * 2),
	);
	const anchor = placeSelectionCard(screen, {
		width: renderedWidth,
		height,
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
	});
	const anchoredToSelection = Boolean(screen.selectionBounds) && !position;
	useLayoutEffect(() => {
		const card = rootRef.current;
		if (!anchoredToSelection || !card) return;
		const measure = () => {
			const rect = card.getBoundingClientRect();
			if (resizable && !lockHeight && card.style.height) {
				// Native corner resizing takes over from the initial anchor.
				setPosition({ left: rect.left, top: rect.top });
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
	const left = position
		? clamp(
				position.left,
				edge,
				Math.max(
					edge,
					viewport.width -
						edge -
						(resizable ? RESIZE_MIN_WIDTH : renderedWidth),
				),
			)
		: anchor.left;
	const top = position
		? clamp(
				position.top,
				edge,
				Math.max(edge, viewport.height - edge - SELECTION_CARD_MIN_HEIGHT),
			)
		: anchor.top;
	const maxHeight = anchor.maxHeight;
	const resizeMaxWidth = Math.max(
		0,
		viewport.width - left - SELECTION_CARD_EDGE,
	);
	const resizeMaxHeight = Math.min(
		anchoredToSelection ? maxHeight : Infinity,
		Math.max(0, viewport.height - top - SELECTION_CARD_EDGE),
	);
	// Locked cards use the placement cap while anchored; after a drag, shrink
	// to the room below the new top so a short window does not overflow.
	const cardMaxHeight = position
		? Math.min(height, resizeMaxHeight)
		: maxHeight;
	// The gutter pin sits on the side the card opens toward. Reveal the card
	// from that corner so it looks like the pin expands into the full card.
	const isRightSide = anchor.left + renderedWidth / 2 >= screen.x;
	const originClip = isRightSide
		? "inset(0 100% 100% 0)"
		: "inset(0 0 100% 100%)";
	const transition = reduceMotion
		? { duration: 0 }
		: { type: "spring" as const, bounce: 0.15, duration: 0.35 };
	const titleNode = (
		<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
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
		};
	};

	const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const rect = rootRef.current?.getBoundingClientRect();
		if (!rect) return;
		setPosition({
			left: clamp(
				event.clientX - drag.x,
				edge,
				Math.max(edge, viewport.width - edge - rect.width),
			),
			top: clamp(
				event.clientY - drag.y,
				edge,
				Math.max(edge, viewport.height - edge - rect.height),
			),
		});
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
							minWidth: Math.min(RESIZE_MIN_WIDTH, resizeMaxWidth),
							minHeight: Math.min(resizeMinHeight, resizeMaxHeight),
							maxWidth: resizeMaxWidth,
							maxHeight: resizeMaxHeight,
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
					"relative flex shrink-0 items-center gap-2 border-border/60 border-b px-3 py-2",
					draggable &&
						"touch-none select-none cursor-grab active:cursor-grabbing",
					draggable && showDragHandle && "pt-2.5",
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
						className="pointer-events-none absolute top-1 left-1/2 size-3.5 -translate-x-1/2 text-muted-foreground"
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
