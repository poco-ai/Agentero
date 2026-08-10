import {
	Check,
	Copy,
	Languages,
	MessageSquare,
	MessageSquarePlus,
	NotebookPen,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { cn } from "@/lib/core/utils";
import {
	HIGHLIGHT_COLORS,
	type HighlightColor,
	swatchColorClass,
} from "@/lib/pdf/highlight/palette";

type SelectionMenuProps = {
	/** Screen point near the top-center of the selection (toolbar anchor) */
	screen: ScreenPoint;
	/** Create a highlight in the chosen color */
	onHighlight: (color: HighlightColor) => void;
	/** Copy the selected text to the clipboard */
	onCopy: () => void;
	/** Annotate: create a highlight and open its inline note editor */
	onNote: () => void;
	onAsk: () => void;
	/** Pin the selection as an Agent composer context chip and open the chat. */
	onAddToChat: () => void;
	onTranslate: () => void;
	/** Dismiss the menu without acting */
	onClose: () => void;
};

const BAR_W = 340;
const BAR_H = 40;
const COPIED_FLASH_MS = 1500;

/**
 * Floating action bar shown next to a text selection: a row of color swatches
 * (highlight), then Copy / Annotate / Ask / Translate.
 * Copy keeps the bar open and swaps the copy icon for a check briefly.
 */
export function SelectionMenu({
	screen,
	onHighlight,
	onCopy,
	onNote,
	onAsk,
	onAddToChat,
	onTranslate,
	onClose,
}: SelectionMenuProps) {
	const { t } = useTranslation("viewer");
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	let left = screen.x - BAR_W / 2;
	left = Math.min(Math.max(12, left), vw - BAR_W - 12);
	// Prefer just above the selection; flip below if near the top edge
	let top = screen.y - BAR_H - 10;
	let overContent = false;
	if (top < 12) {
		top = Math.min(vh - BAR_H - 12, screen.y + 18);
		// Menu sits below the selection and may cover body text.
		overContent = true;
	}

	const handleCopy = useCallback(() => {
		onCopy();
		setCopied(true);
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			setCopied(false);
		}, COPIED_FLASH_MS);
	}, [onCopy]);

	// Annotate opens the inline note editor in the viewer, so just close the menu.
	const handleNote = useCallback(() => {
		onNote();
		onClose();
	}, [onNote, onClose]);

	const colorLabel = (c: HighlightColor): string => {
		switch (c) {
			case "yellow":
				return t("selection.color.yellow");
			case "green":
				return t("selection.color.green");
			case "blue":
				return t("selection.color.blue");
			case "pink":
				return t("selection.color.pink");
			default:
				return t("selection.color.purple");
		}
	};

	return (
		<div
			className={cn(
				"fixed z-50 flex h-10 items-center gap-0.5 rounded-xl border border-border/80 bg-background px-1 shadow-2xl ring-1 ring-black/5 dark:ring-white/10",
				// Only dim when flipped below the selection (covers body text).
				overContent &&
					"bg-background/80 backdrop-blur-sm transition-[background-color] duration-150 hover:bg-background",
			)}
			style={{ left, top }}
			role="toolbar"
			aria-label={t("selection.menuLabel")}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<TooltipProvider delayDuration={200}>
				{HIGHLIGHT_COLORS.map((c) => (
					<Tooltip key={c}>
						<TooltipTrigger asChild>
							<button
								type="button"
								aria-label={colorLabel(c)}
								className={cn(
									"mx-0.5 size-4 shrink-0 rounded-full ring-1 ring-black/15 transition hover:scale-110 dark:ring-white/25",
									swatchColorClass(c),
								)}
								onClick={() => onHighlight(c)}
							/>
						</TooltipTrigger>
						<TooltipContent side="top">{colorLabel(c)}</TooltipContent>
					</Tooltip>
				))}
				<div className="mx-1 h-5 w-px shrink-0 bg-border" />
				<div className="relative">
					{copied ? (
						<span
							className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border/80 bg-background px-1.5 py-0.5 text-[11px] text-foreground shadow-sm ring-1 ring-black/5 dark:ring-white/10"
							role="status"
							aria-live="polite"
						>
							{t("selection.copied")}
						</span>
					) : null}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={
									copied ? t("selection.copied") : t("selection.copy")
								}
								onClick={handleCopy}
							>
								{copied ? (
									<Check className="size-4 text-foreground" aria-hidden />
								) : (
									<Copy className="size-4" />
								)}
							</Button>
						</TooltipTrigger>
						{!copied ? (
							<TooltipContent side="top">{t("selection.copy")}</TooltipContent>
						) : null}
					</Tooltip>
				</div>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("selection.note")}
							onClick={handleNote}
						>
							<NotebookPen className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="top">{t("selection.note")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("selection.ask")}
							onClick={onAsk}
						>
							<MessageSquare className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="top">{t("selection.ask")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("selection.addToChat")}
							onClick={onAddToChat}
						>
							<MessageSquarePlus className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="top">{t("selection.addToChat")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("selection.translate")}
							onClick={onTranslate}
						>
							<Languages className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="top">{t("selection.translate")}</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		</div>
	);
}
