/**
 * Persistent entry for a partially translated document. Sits next to the main
 * translate button (overlay toolbar / dual-pane panel) and opens a popover with
 * the gap summary, pending-only completion and a confirmed full retranslate.
 */

import { TriangleAlert, X } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import type { PdfLayoutTranslatePartial } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { cn } from "@/lib/core/utils";
import { openSettingsWindow } from "@/lib/shell/settings-window";

type PdfTranslatePartialButtonProps = {
	partial: PdfLayoutTranslatePartial;
	className?: string;
};

type PdfTranslatePartialDialogProps = {
	translatedCount: number;
	totalCount: number;
	pendingRequired: number;
	/** Localized page span, or null when nothing is pending. */
	pages: string | null;
	completionFailed: boolean;
	layoutWarningPages: string | null;
	layoutWarningCount: number;
	layoutPageCount: number | null;
	translatedPageCount: number;
	confirming: boolean;
	onConfirmingChange: (confirming: boolean) => void;
	onCompleteMissing: () => void;
	onRetranslateAll: () => void;
	onReparseAndTranslate: () => void;
	onClose: () => void;
};

function DialogCloseButton({
	label,
	onClose,
}: {
	label: string;
	onClose: () => void;
}) {
	return (
		<Button
			type="button"
			size="icon-xs"
			variant="ghost"
			className="-mt-0.5 -mr-1 shrink-0"
			aria-label={label}
			onClick={onClose}
		>
			<X className="size-3.5" aria-hidden />
		</Button>
	);
}

/**
 * Content of the partial-translation popover. Split from the trigger so both
 * panels can mount the same button without duplicating the copy.
 */
export function PdfTranslatePartialDialog({
	translatedCount,
	totalCount,
	pendingRequired,
	pages,
	completionFailed,
	layoutWarningPages,
	layoutWarningCount,
	layoutPageCount,
	translatedPageCount,
	confirming,
	onConfirmingChange,
	onCompleteMissing,
	onRetranslateAll,
	onReparseAndTranslate,
	onClose,
}: PdfTranslatePartialDialogProps) {
	const { t } = useTranslation("viewer");
	const hasLayoutWarning =
		layoutWarningCount > 0 && Boolean(layoutWarningPages);
	const warningsOnly = hasLayoutWarning && pendingRequired === 0;

	if (confirming) {
		return (
			<>
				<PopoverHeader>
					<div className="flex items-start justify-between gap-2">
						<PopoverTitle>
							{t("pdf.layoutTranslate.retranslateConfirmTitle")}
						</PopoverTitle>
						<DialogCloseButton
							label={t("pdf.layoutTranslate.close")}
							onClose={onClose}
						/>
					</div>
					<PopoverDescription>
						{t("pdf.layoutTranslate.retranslateConfirmDescription")}
					</PopoverDescription>
				</PopoverHeader>
				<div className="flex justify-end gap-1.5">
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => onConfirmingChange(false)}
					>
						{t("pdf.layoutTranslate.cancel")}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="destructive"
						onClick={onRetranslateAll}
					>
						{t("pdf.layoutTranslate.retranslateConfirm")}
					</Button>
				</div>
			</>
		);
	}

	return (
		<>
			<PopoverHeader>
				<div className="flex items-start justify-between gap-2">
					<PopoverTitle>
						{warningsOnly
							? t("pdf.layoutTranslate.layoutWarningTitle")
							: t("pdf.layoutTranslate.partialTitle")}
					</PopoverTitle>
					<DialogCloseButton
						label={t("pdf.layoutTranslate.close")}
						onClose={onClose}
					/>
				</div>
				<div className="space-y-1.5">
					{hasLayoutWarning ? (
						<PopoverDescription className="text-amber-700 dark:text-amber-400">
							{t("pdf.layoutTranslate.layoutWarningSummary", {
								pages: layoutWarningPages,
								translated: translatedPageCount,
								total: layoutPageCount ?? totalCount,
							})}
						</PopoverDescription>
					) : null}
					{pendingRequired > 0 ? (
						<PopoverDescription>
							{t("pdf.layoutTranslate.partialSummary", {
								translated: translatedCount,
								total: totalCount,
								pending: pendingRequired,
								pages: pages ?? "",
							})}{" "}
							{t("pdf.layoutTranslate.partialHint")}
							{completionFailed
								? ` ${t("pdf.layoutTranslate.partialStillMissing", {
										count: pendingRequired,
									})}`
								: null}
						</PopoverDescription>
					) : null}
				</div>
			</PopoverHeader>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() =>
						openSettingsWindow(warningsOnly ? "layout" : "translate")
					}
				>
					{warningsOnly
						? t("pdf.layoutTranslate.openLayoutSettings")
						: t("pdf.layoutTranslate.openSettings")}
				</Button>
				<div className="ml-auto flex flex-wrap items-center gap-1.5">
					{hasLayoutWarning ? (
						<Button type="button" size="sm" onClick={onReparseAndTranslate}>
							{t("pdf.layoutTranslate.reparseAndTranslate")}
						</Button>
					) : null}
					{pendingRequired > 0 ? (
						<Button type="button" size="sm" onClick={onCompleteMissing}>
							{t("pdf.layoutTranslate.completeMissing", {
								count: pendingRequired,
							})}
						</Button>
					) : null}
					{totalCount > 0 && !hasLayoutWarning ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => onConfirmingChange(true)}
						>
							{t("pdf.layoutTranslate.retranslateAll")}
						</Button>
					) : null}
				</div>
			</div>
		</>
	);
}

/** Manual recovery entry, rendered only while `partial.visible` is true. */
export const PdfTranslatePartialButton = memo(
	function PdfTranslatePartialButton({
		partial,
		className,
	}: PdfTranslatePartialButtonProps) {
		const { t } = useTranslation("viewer");
		const [confirming, setConfirming] = useState(false);
		const {
			pendingRequired,
			translatedCount,
			totalCount,
			pageRange,
			open,
			completionFailed,
			layoutWarningPages,
			layoutWarningCount,
			layoutPageCount,
			translatedPageCount,
			onOpenChange,
			onCompleteMissing,
			onRetranslateAll,
			onReparseAndTranslate,
		} = partial;

		const pages = pageRange
			? pageRange.start === pageRange.end
				? t("pdf.layoutTranslate.partialPagesSingle", {
						page: pageRange.start,
					})
				: t("pdf.layoutTranslate.partialPagesRange", {
						start: pageRange.start,
						end: pageRange.end,
					})
			: null;
		const label =
			layoutWarningCount > 0 && pendingRequired === 0
				? t("pdf.layoutTranslate.layoutWarningButton", {
						count: layoutWarningCount,
					})
				: completionFailed
					? t("pdf.layoutTranslate.partialButtonRemaining", {
							count: pendingRequired,
						})
					: t("pdf.layoutTranslate.partialButton", {
							count: pendingRequired,
						});

		const handleOpenChange = useCallback(
			(next: boolean) => {
				if (!next) setConfirming(false);
				onOpenChange(next);
			},
			[onOpenChange],
		);
		const handleComplete = useCallback(() => {
			setConfirming(false);
			onOpenChange(false);
			onCompleteMissing();
		}, [onCompleteMissing, onOpenChange]);
		const handleRetranslate = useCallback(() => {
			setConfirming(false);
			onOpenChange(false);
			onRetranslateAll();
		}, [onOpenChange, onRetranslateAll]);
		const handleReparse = useCallback(() => {
			setConfirming(false);
			onOpenChange(false);
			onReparseAndTranslate();
		}, [onOpenChange, onReparseAndTranslate]);

		return (
			// Non-modal on purpose: the reader must keep scrolling the PDF while
			// the summary is open. Radix's modal wrapper installs RemoveScroll.
			<Popover open={open} onOpenChange={handleOpenChange}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						size="icon-xs"
						variant="ghost"
						data-full-text-translate-partial
						aria-label={label}
						title={label}
						className={cn(
							"bg-transparent text-amber-600 hover:text-amber-700 active:text-amber-700 aria-expanded:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 dark:active:text-amber-300 dark:aria-expanded:text-amber-300",
							className,
						)}
					>
						<TriangleAlert className="size-3.5" aria-hidden />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="end"
					side="bottom"
					sideOffset={6}
					collisionPadding={12}
					// Keep the right edge glued to the trigger when the toolbar or
					// panel relayouts, instead of leaving a stale measured position.
					updatePositionStrategy="always"
					className="w-[23rem] max-w-[calc(100vw-1.5rem)]"
				>
					<PdfTranslatePartialDialog
						translatedCount={translatedCount}
						totalCount={totalCount}
						pendingRequired={pendingRequired}
						pages={pages}
						completionFailed={completionFailed}
						layoutWarningPages={layoutWarningPages}
						layoutWarningCount={layoutWarningCount}
						layoutPageCount={layoutPageCount}
						translatedPageCount={translatedPageCount}
						confirming={confirming}
						onConfirmingChange={setConfirming}
						onCompleteMissing={handleComplete}
						onRetranslateAll={handleRetranslate}
						onReparseAndTranslate={handleReparse}
						onClose={() => handleOpenChange(false)}
					/>
				</PopoverContent>
			</Popover>
		);
	},
);
