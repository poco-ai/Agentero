import type { LucideIcon } from "lucide-react";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
} from "react";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { clamp } from "@/lib/core/math";
import { cn } from "@/lib/core/utils";

/** Minimum inset from the viewport edges (px). */
export const SELECTION_CARD_EDGE = 12;
/** Default preferred max height when callers omit `height` (px). */
const SELECTION_CARD_DEFAULT_MAX_HEIGHT = 420;
/** Floor so a clipped card remains usable on short viewports (px). */
const SELECTION_CARD_MIN_HEIGHT = 120;

type SelectionCardAction = {
	label: string;
	onClick: () => void;
	icon: ReactNode;
	/** Destructive styling for the header icon button */
	destructive?: boolean;
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
	/** Gap from the anchor point (default 4). */
	gap?: number;
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
	screen: ScreenPoint,
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
	screen: ScreenPoint;
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
	/**
	 * When false, the body does not scroll (`agentero-scroll` off) and grows
	 * with content. Use for short tables that should show fully (formula legend).
	 * Still clamped by placement `maxHeight` via the outer shell when needed.
	 */
	bodyScroll?: boolean;
	preferRight?: boolean;
	title: string;
	icon: LucideIcon;
	/** Header trailing icon buttons (close / hide / delete …). */
	actions?: SelectionCardAction[];
	/** Accessible name; defaults to title. */
	ariaLabel?: string;
	/** Announce body updates (e.g. streaming translation). */
	ariaLive?: "polite" | "off";
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
	bodyScroll = true,
	preferRight = true,
	title,
	icon: Icon,
	actions,
	ariaLabel,
	ariaLive = "off",
	onPointerEnter,
	onPointerLeave,
	footer,
	className,
	bodyClassName,
	children,
}: SelectionCardProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const { left, top, maxHeight } = placeSelectionCard(screen, {
		width,
		height,
		placementWidth,
		placementHeight,
		trackPin,
		preferRight,
	});

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

	return (
		<div
			ref={rootRef}
			className={cn(
				"fixed z-50 flex flex-col",
				// Content-sized cards (no body scroll) should not clip children.
				bodyScroll || lockHeight ? "overflow-hidden" : "overflow-visible",
				"rounded-xl border border-border/80 bg-background text-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10",
				className,
			)}
			style={{
				left,
				top,
				width: `min(${width}px, calc(100vw - ${SELECTION_CARD_EDGE * 2}px))`,
				// Only enforce maxHeight when the body is a scroller / locked;
				// content-sized cards grow with their children (viewport clamp is
				// still applied via placeSelectionCard when height is large).
				...(bodyScroll || lockHeight ? { maxHeight } : null),
				// Definite height so flex-1 + nested height:100% scroll areas work.
				...(lockHeight ? { height: maxHeight } : null),
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
			<header className="flex shrink-0 items-center gap-2 border-border/60 border-b px-3 py-2">
				<Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
				<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
					{title}
				</span>
				{actions && actions.length > 0 ? (
					// disableHoverableContent: tooltip is portaled outside the card;
					// moving into it would fire pointerleave and start the hide timer.
					<TooltipProvider delayDuration={200} disableHoverableContent>
						<div className="flex items-center gap-0.5">
							{actions.map((a) => (
								<Tooltip key={a.label}>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-label={a.label}
											// Native button (not ghost Button): avoid variant
											// hover:text-foreground fighting the red icon color.
											className={cn(
												"inline-flex size-6 shrink-0 items-center justify-center rounded-md",
												"text-muted-foreground transition-colors outline-none",
												"focus-visible:ring-2 focus-visible:ring-ring/50",
												a.destructive
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
									<TooltipContent side="bottom">{a.label}</TooltipContent>
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
		</div>
	);
}
