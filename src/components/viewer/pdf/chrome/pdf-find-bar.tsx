import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { RefObject } from "react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { cn } from "@/lib/core/utils";

type PdfFindBarProps = {
	open: boolean;
	inputRef: RefObject<HTMLInputElement | null>;
	query: string;
	onQueryChange: (value: string) => void;
	/** Total matches for the current query. */
	total: number;
	/** 0-based index of the focused match. */
	activeResultIndex: number;
	onFindNext: () => void;
	onFindPrev: () => void;
	onClose: () => void;
};

/** ⌘F find bar: query input, match counter, prev / next / close. */
export const PdfFindBar = memo(function PdfFindBar({
	open,
	inputRef,
	query,
	onQueryChange,
	total,
	activeResultIndex,
	onFindNext,
	onFindPrev,
	onClose,
}: PdfFindBarProps) {
	const { t } = useTranslation("viewer");

	if (!open) return null;

	return (
		<TooltipProvider delayDuration={200}>
			<div
				data-pdf-chrome
				className={cn(
					"absolute top-12 right-3 z-30 flex origin-top-right select-none items-center gap-1 rounded-lg p-1 shadow-overlay",
					PDF_CHROME_CHIP,
					"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-200 motion-reduce:animate-none",
				)}
			>
				<Search className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
				<input
					ref={inputRef}
					type="text"
					className="w-40 select-text bg-transparent text-sm outline-none"
					placeholder={t("pdf.findPlaceholder")}
					value={query}
					onChange={(e) => onQueryChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							if (e.shiftKey) onFindPrev();
							else onFindNext();
						} else if (e.key === "Escape") {
							e.preventDefault();
							onClose();
						}
					}}
				/>
				<span className="min-w-11 shrink-0 px-1 text-center text-muted-foreground text-xs tabular-nums">
					{query.trim()
						? total > 0
							? `${activeResultIndex + 1}/${total}`
							: t("pdf.findNoResults")
						: ""}
				</span>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label={t("pdf.findPrev")}
							disabled={total === 0}
							onClick={onFindPrev}
						>
							<ChevronUp className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("pdf.findPrev")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label={t("pdf.findNext")}
							disabled={total === 0}
							onClick={onFindNext}
						>
							<ChevronDown className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("pdf.findNext")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label={t("pdf.findClose")}
							onClick={onClose}
						>
							<X className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("pdf.findClose")}</TooltipContent>
				</Tooltip>
			</div>
		</TooltipProvider>
	);
});
