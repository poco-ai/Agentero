import { motion, useReducedMotion } from "motion/react";
import { type Ref, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import type { MarkupShapes } from "@/lib/pdf/highlight/markup-pref";
import {
	HIGHLIGHT_COLORS,
	type HighlightColor,
	swatchBorderClass,
	swatchColorClass,
} from "@/lib/pdf/highlight/palette";
import { formatShortcut } from "@/lib/shell/shortcuts";

/** Visual size of each color dot (px). */
const CARD = 16;
/** Collapsed center-to-center step — ~50% overlap. */
const COLLAPSED_STEP = 8;
/** Expanded center-to-center step — card + gap. */
const EXPANDED_STEP = 20;
/** Hit padding around the card so the target stays ≥ 24px (WCAG 2.5.8). */
const HIT_PAD = 4;

const COUNT = HIGHLIGHT_COLORS.length;
const BTN = CARD + HIT_PAD * 2;

export const HIGHLIGHT_COLOR_STACK_COLLAPSED_W =
	BTN + (COUNT - 1) * COLLAPSED_STEP;
export const HIGHLIGHT_COLOR_STACK_EXPANDED_W =
	BTN + (COUNT - 1) * EXPANDED_STEP;
const SLOT_H = BTN;

const SPRING = { type: "spring" as const, bounce: 0.2, duration: 0.32 };
const SNAP = { type: "tween" as const, duration: 0 };

type HighlightColorStackProps = {
	ref?: Ref<HTMLFieldSetElement>;
	onSelect: (color: HighlightColor) => void;
	/**
	 * Shape each swatch applies on click. Filled dots mean highlight, hollow
	 * rings mean underline. Omitted in the recolor menu, which keeps solid dots.
	 */
	shapes?: MarkupShapes;
	/** Right-click flips just that swatch; the caller persists it. */
	onToggleShape?: (color: HighlightColor) => void;
	/** Currently active color (annotation recolor menu). */
	activeColor?: HighlightColor;
	/** Number-key hints when composed into the text selection menu. */
	shortcuts?: boolean;
	/** Tooltip / expand direction relative to the toolbar. */
	tooltipSide?: "top" | "bottom";
	className?: string;
};

/**
 * Semi-overlapping highlight color dots. Hover / focus-within fans them out
 * to the left (right edge stays anchored near the toolbar divider) with a
 * compact spring. Only this slot's width animates — parents should pin the
 * toolbar by its right edge so sibling actions do not move.
 */
export function HighlightColorStack({
	ref,
	onSelect,
	shapes,
	onToggleShape,
	activeColor,
	shortcuts = false,
	tooltipSide = "top",
	className,
}: HighlightColorStackProps) {
	const { t } = useTranslation("viewer");
	const reduceMotion = useReducedMotion();
	const [expanded, setExpanded] = useState(false);

	const open = useCallback(() => setExpanded(true), []);
	const close = useCallback(() => setExpanded(false), []);

	const step = expanded ? EXPANDED_STEP : COLLAPSED_STEP;
	const width = expanded
		? HIGHLIGHT_COLOR_STACK_EXPANDED_W
		: HIGHLIGHT_COLOR_STACK_COLLAPSED_W;
	const transition = reduceMotion ? SNAP : SPRING;

	const colorLabel = (c: HighlightColor): string => t(`selection.color.${c}`);

	return (
		<motion.fieldset
			ref={ref}
			className={cn("relative m-0 min-w-0 shrink-0 border-0 p-0", className)}
			initial={false}
			animate={{ width }}
			transition={transition}
			style={{ height: SLOT_H }}
			onMouseEnter={open}
			onMouseLeave={close}
			onFocusCapture={open}
			onBlurCapture={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
					close();
				}
			}}
			aria-label={t("selection.colorGroupLabel")}
		>
			{HIGHLIGHT_COLORS.map((color, i) => {
				// Purple (last) anchors at the right; yellow fans furthest left.
				const fromRight = (COUNT - 1 - i) * step;
				const isActive = activeColor === color;
				const shape = shapes?.[color];
				const hollow = shape === "underline";
				// The recolor menu passes no shapes: solid, unlabeled dots.
				const shapeLabel = shape
					? hollow
						? t("selection.shapeUnderline")
						: t("selection.shapeHighlight")
					: null;
				const toggleHint = hollow
					? t("selection.shapeSwitchHint.toHighlight")
					: t("selection.shapeSwitchHint.toUnderline");
				const shortcutKey = String(i + 1);
				// Bare digit applies the swatch's remembered shape; the modifier
				// variant forces an underline. A future wavy shape gets another
				// modifier prefix and its own hint line here.
				const underlineShortcut = formatShortcut({
					key: shortcutKey,
					alt: true,
				});
				return (
					<Tooltip key={color}>
						<TooltipTrigger asChild>
							<motion.button
								type="button"
								aria-label={
									shapeLabel
										? `${colorLabel(color)} · ${shapeLabel}`
										: colorLabel(color)
								}
								aria-keyshortcuts={
									shortcuts ? `${shortcutKey} Alt+${shortcutKey}` : undefined
								}
								aria-pressed={activeColor ? isActive : undefined}
								className={cn(
									"absolute top-0 inline-flex items-center justify-center rounded-full outline-none",
									"focus-visible:ring-2 focus-visible:ring-ring/50",
									"active:scale-[0.94] motion-reduce:active:scale-100",
								)}
								style={{
									width: BTN,
									height: BTN,
									// Yellow stays on top when collapsed so the stack keeps
									// the same overlap order as the text-selection toolbar.
									zIndex: COUNT - i,
								}}
								initial={false}
								animate={{ right: fromRight }}
								transition={transition}
								onClick={() => onSelect(color)}
								onContextMenu={(event) => {
									// Right-click flips this swatch only instead of
									// applying it, so it never opens a context menu.
									event.preventDefault();
									event.stopPropagation();
									onToggleShape?.(color);
								}}
							>
								<span
									className={cn(
										// Dark edge so overlapping dots stay separable.
										"block size-4 rounded-full shadow-sm ring-1 ring-black/55 transition-[background-color,border-color,box-shadow] dark:ring-black/70 dark:ring-offset-0",
										hollow
											? cn(
													"border-[3px] bg-background",
													swatchBorderClass(color),
												)
											: swatchColorClass(color),
										isActive &&
											"ring-2 ring-foreground/70 ring-offset-1 ring-offset-background",
										expanded && "shadow-md",
									)}
									aria-hidden
								/>
							</motion.button>
						</TooltipTrigger>
						<TooltipContent side={tooltipSide}>
							<span className="flex flex-col gap-0.5 text-left">
								<span>
									{colorLabel(color)}
									{shapeLabel ? (
										<>
											<span className="mx-1 opacity-50">·</span>
											{shapeLabel}
										</>
									) : null}
									{shortcuts ? (
										<kbd className="ml-2 font-sans text-[10px] opacity-70">
											{shortcutKey}
										</kbd>
									) : null}
								</span>
								{shortcuts ? (
									<span className="text-[10px] opacity-60">
										<kbd className="font-sans">{underlineShortcut}</kbd>{" "}
										{t("selection.shapeUnderline")}
									</span>
								) : null}
								{onToggleShape ? (
									<span className="text-[10px] opacity-60">{toggleHint}</span>
								) : null}
							</span>
						</TooltipContent>
					</Tooltip>
				);
			})}
		</motion.fieldset>
	);
}
