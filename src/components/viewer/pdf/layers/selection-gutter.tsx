import type { LucideIcon } from "lucide-react";
import {
	Languages,
	MessageSquare,
	MessageSquareText,
	ScanSearch,
} from "lucide-react";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import type { SelectionPin } from "@/lib/pdf/selection";

type SelectionGutterProps = {
	/** Pins for this page only (ask + annotate + translate + agent-trace) */
	items: SelectionPin[];
	activeId: string | null;
	onOpen: (pin: SelectionPin, preview?: boolean) => void;
	/** Leave pin — parent may schedule delayed hide (ask hover UX) */
	onLeave?: (pin: SelectionPin) => void;
	/** Enter pin — cancel pending hide */
	onEnter?: (pin: SelectionPin) => void;
};

const PILL = 24;
const GAP = 4;

/**
 * Nudge overlapping pins vertically so they stay clickable.
 * Keeps x on the line side (does not slide pins into mid-line).
 * Positions are page-normalized 0–1; page size used only for collision in px.
 */
function layoutPins(
	items: SelectionPin[],
	pageW: number,
	pageH: number,
): Array<{
	id: string;
	kind: SelectionPin["kind"];
	leftPct: number;
	topPct: number;
	side: "left" | "right";
}> {
	const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
	const placed: Array<{
		id: string;
		kind: SelectionPin["kind"];
		x: number;
		y: number;
		side: "left" | "right";
	}> = [];
	const edgeY = Math.min(0.5, PILL / 2 / pageH);
	const minY = edgeY;
	const maxY = 1 - edgeY;
	const slotStep = (PILL + GAP) / pageH;
	const slotCount = Math.max(1, Math.floor((maxY - minY) / slotStep) + 1);
	const slotSpacing = slotCount > 1 ? (maxY - minY) / (slotCount - 1) : 0;
	const slots = Array.from(
		{ length: slotCount },
		(_, index) => minY + index * slotSpacing,
	);

	for (const it of sorted) {
		const x = Math.min(0.98, Math.max(0.02, it.x));
		const baseY = Math.min(maxY, Math.max(minY, it.y));
		const side = it.side ?? "right";
		let y = baseY;
		let bestClearance = -1;
		const orderedSlots = [...slots].sort(
			(a, b) => Math.abs(a - baseY) - Math.abs(b - baseY),
		);
		for (const slot of orderedSlots) {
			let clearance = Number.POSITIVE_INFINITY;
			for (const p of placed) {
				const dx = (x - p.x) * pageW;
				const dy = (slot - p.y) * pageH;
				clearance = Math.min(clearance, Math.max(Math.abs(dx), Math.abs(dy)));
			}
			if (clearance > bestClearance) {
				bestClearance = clearance;
				y = slot;
			}
			if (clearance >= PILL + GAP) {
				y = slot;
				break;
			}
		}
		placed.push({ id: it.id, kind: it.kind, x, y, side });
	}

	return placed.map((p) => ({
		id: p.id,
		kind: p.kind,
		leftPct: p.x * 100,
		topPct: p.y * 100,
		side: p.side,
	}));
}

/**
 * Header glyph per pin kind. Translation pins are only shown for records the
 * reader explicitly pinned; the marker reopens the saved result card.
 */
function pinIcon(kind: SelectionPin["kind"]): LucideIcon | null {
	switch (kind) {
		case "ask":
			return MessageSquare;
		case "annotate":
			return MessageSquareText;
		case "translate":
			return Languages;
		case "visual":
		case "agent-trace":
			return ScanSearch;
	}
}

/**
 * Unified page pins for selection workflows: ask / annotate / translate / agent-trace.
 * Hover opens the kind-specific card (ask / translate / visual-trace preview).
 *
 * Default appearance is solid (unchanged). Only pins flagged `overText` render
 * translucent at rest so body text stays readable; hover / focus / active
 * restore full opacity.
 */
export const SelectionGutter = memo(function SelectionGutter({
	items,
	activeId,
	onOpen,
	onLeave,
	onEnter,
}: SelectionGutterProps) {
	const { t } = useTranslation("viewer");
	// Layout depends only on the pin set (600/800 are constants); hover-driven
	// re-renders (activeId flips) must not redo the sort + collision resolution.
	const laid = useMemo(() => layoutPins(items, 600, 800), [items]);
	const byKey = useMemo(
		() => new Map(items.map((it) => [`${it.kind}:${it.id}`, it])),
		[items],
	);
	if (!items.length) return null;

	return (
		<div
			className="pointer-events-none absolute inset-0 z-10"
			aria-hidden={false}
		>
			{laid.map((pos) => {
				const item = byKey.get(`${pos.kind}:${pos.id}`);
				if (!item) return null;
				const Icon = pinIcon(item.kind);
				const aria =
					item.kind === "ask"
						? t("pdfAsk.pillAria", { preview: item.preview })
						: item.kind === "annotate"
							? t("annotations.pinAria", { preview: item.preview })
							: item.kind === "visual" || item.kind === "agent-trace"
								? t("pdfExplain.tracePinAria", { preview: item.preview })
								: t("selection.translatePinAria", { preview: item.preview });
				// agent-trace activeCard.id is the per-annotation pin id.
				const isActive = activeId === item.id;
				// Opacity may change on hover/active; transform must stay fixed to
				// `side` or the pin jumps when isActive flips dimForText.
				const dimForText = Boolean(item.overText) && !isActive;
				const wrapTransform =
					pos.side === "left"
						? "translate(calc(-100% - 2px), -50%)"
						: "translate(2px, -50%)";

				return (
					<div
						key={`${item.kind}-${item.id}`}
						className="pointer-events-auto absolute"
						style={{
							left: `${pos.leftPct}%`,
							top: `${pos.topPct}%`,
							transform: wrapTransform,
						}}
					>
						<button
							type="button"
							className={cn(
								"flex size-6 items-center justify-center rounded-md border shadow-raised transition-[opacity,background-color] duration-150 hover:scale-110",
								item.kind === "ask" && item.ended
									? "border-amber-600/35 bg-background text-amber-600 dark:text-amber-400"
									: item.kind === "translate"
										? "border-sky-600/35 bg-background text-sky-700 dark:text-sky-400"
										: item.kind === "visual" || item.kind === "agent-trace"
											? "border-violet-600/35 bg-background text-violet-700 dark:text-violet-400"
											: "border-border/80 bg-background text-muted-foreground",
								dimForText &&
									"bg-background/55 opacity-40 backdrop-blur-[1px] hover:bg-background hover:opacity-100 focus-visible:bg-background focus-visible:opacity-100",
								isActive && "ring-2 ring-ring ring-offset-1",
							)}
							aria-label={aria}
							// Match SelectionCard pointer model so pin leave / card
							// enter share one hover surface (mouse-only races hide).
							onPointerEnter={() => {
								onEnter?.(item);
								onOpen(item, true);
							}}
							onPointerLeave={() => onLeave?.(item)}
							onFocus={() => {
								onEnter?.(item);
								onOpen(item, true);
							}}
							onClick={(e) => {
								e.stopPropagation();
								onEnter?.(item);
								onOpen(item);
							}}
						>
							{Icon ? <Icon className="size-3.5" strokeWidth={2} /> : null}
						</button>
					</div>
				);
			})}
		</div>
	);
});
