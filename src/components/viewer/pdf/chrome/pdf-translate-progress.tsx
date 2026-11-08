import { Check, Square } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { useTranslateMeter } from "@/components/viewer/pdf/hooks/use-translate-meter";
import { cn } from "@/lib/core/utils";

type PdfTranslateProgressChipProps = {
	layoutTranslateRunning: boolean;
	layoutTranslatePreparing?: boolean;
	layoutTranslateWaiting?: boolean;
	layoutTranslateProgress?: number | null;
	onStop: () => void;
};

/**
 * Floating full-text translation meter for the dual-pane translation panel.
 * The panel owns the job but hides the source toolbar, so this keeps the same
 * stage / percentage feedback visible while the translation runs.
 */
export function PdfTranslateProgressChip({
	layoutTranslateRunning,
	layoutTranslatePreparing = false,
	layoutTranslateWaiting = false,
	layoutTranslateProgress = null,
	onStop,
}: PdfTranslateProgressChipProps) {
	const { t } = useTranslation("viewer");
	const { open, indeterminate, ratio, percent, stage, width, lingerFull } =
		useTranslateMeter({
			layoutTranslateRunning,
			layoutTranslatePreparing,
			layoutTranslateWaiting,
			layoutTranslateProgress,
		});
	if (!open) return null;
	const cancellable = layoutTranslateRunning || layoutTranslateWaiting;
	const stopLabel = layoutTranslateWaiting
		? t("pdf.layoutTranslate.waiting")
		: t("pdf.layoutTranslate.stop");

	return (
		<div
			data-pdf-chrome
			className={cn(
				"pointer-events-none absolute top-2 right-3 z-20 flex h-7 select-none items-center gap-1.5 rounded-lg pl-2.5",
				cancellable || lingerFull ? "pr-0.5" : "pr-2.5",
				PDF_CHROME_CHIP,
			)}
		>
			<span
				role="progressbar"
				className="sr-only"
				aria-label={stage}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={indeterminate ? undefined : Math.round(ratio * 100)}
			/>
			<span
				aria-hidden
				className="text-[0.625rem] font-medium text-foreground/75"
			>
				{stage}
			</span>
			{indeterminate ? null : (
				<span
					aria-hidden
					className="text-[0.625rem] text-muted-foreground tabular-nums"
				>
					{percent}%
				</span>
			)}
			{cancellable ? (
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					className="pointer-events-auto"
					aria-label={stopLabel}
					title={stopLabel}
					onClick={onStop}
				>
					<Square className="size-2.5 fill-current opacity-60" aria-hidden />
				</Button>
			) : lingerFull ? (
				<Check className="size-3.5 text-foreground/70" aria-hidden />
			) : null}
			<span
				aria-hidden
				className="pointer-events-none absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full bg-foreground/5"
			>
				<motion.span
					className={cn(
						"absolute inset-y-0 left-0 rounded-full bg-foreground/45",
						indeterminate && "pdf-translate-indeterminate",
					)}
					style={{ width: indeterminate ? "30%" : width }}
				/>
			</span>
		</div>
	);
}
