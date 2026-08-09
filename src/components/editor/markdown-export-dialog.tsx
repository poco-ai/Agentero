"use client";

import { FileImage, FileText, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { cn } from "@/lib/core/utils";
import type {
	MarkdownExportFormat,
	MarkdownExportOptions,
	MarkdownExportPaperHeader,
} from "@/lib/markdown/export/types";

export type MarkdownExportDialogProps = {
	open: boolean;
	busy: boolean;
	/** Non-null when the note is a paper NOTES.md with catalog meta. */
	paperHeader: MarkdownExportPaperHeader | null;
	/** Prefill from settings (watermark default). */
	defaultWatermark: boolean;
	onCancel: () => void;
	onConfirm: (options: MarkdownExportOptions) => void;
};

export function MarkdownExportDialog({
	open,
	busy,
	paperHeader,
	defaultWatermark,
	onCancel,
	onConfirm,
}: MarkdownExportDialogProps) {
	const { t } = useTranslation("editor");
	const [format, setFormat] = useState<MarkdownExportFormat>("pdf");
	const [expandEmbeds, setExpandEmbeds] = useState(true);
	const [includePaperHeader, setIncludePaperHeader] = useState(true);
	const [watermark, setWatermark] = useState(defaultWatermark);

	useOverlayRegistration("markdown-export", open, () => {
		if (!busy) onCancel();
	});

	useEffect(() => {
		if (!open) return;
		setFormat("pdf");
		setExpandEmbeds(true);
		setIncludePaperHeader(true);
		setWatermark(defaultWatermark);
	}, [open, defaultWatermark]);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) onCancel();
			}}
		>
			<DialogContent className="sm:max-w-md" showCloseButton={!busy}>
				<DialogHeader>
					<DialogTitle>{t("export.title")}</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-1">
					<div className="flex flex-col gap-2">
						<span className="font-medium text-sm">{t("export.format")}</span>
						<div className="grid grid-cols-2 gap-2">
							<FormatButton
								active={format === "pdf"}
								disabled={busy}
								icon={<FileText className="size-4" aria-hidden />}
								label={t("export.formatPdf")}
								onClick={() => setFormat("pdf")}
							/>
							<FormatButton
								active={format === "png"}
								disabled={busy}
								icon={<FileImage className="size-4" aria-hidden />}
								label={t("export.formatPng")}
								onClick={() => setFormat("png")}
							/>
						</div>
					</div>

					<div className="flex flex-col gap-3">
						<OptionRow
							id="export-expand-embeds"
							checked={expandEmbeds}
							disabled={busy}
							label={t("export.expandEmbeds")}
							description={t("export.expandEmbedsHint")}
							onCheckedChange={setExpandEmbeds}
						/>
						{paperHeader ? (
							<OptionRow
								id="export-paper-header"
								checked={includePaperHeader}
								disabled={busy}
								label={t("export.includePaperHeader")}
								description={t("export.includePaperHeaderHint", {
									title: paperHeader.title,
								})}
								onCheckedChange={setIncludePaperHeader}
							/>
						) : null}
						<OptionRow
							id="export-watermark"
							checked={watermark}
							disabled={busy}
							label={t("export.watermarkOption")}
							description={t("export.watermarkOptionHint")}
							onCheckedChange={setWatermark}
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={onCancel}
					>
						{t("export.cancel")}
					</Button>
					<Button
						type="button"
						disabled={busy}
						onClick={() =>
							onConfirm({
								format,
								expandEmbeds,
								includePaperHeader,
								watermark,
							})
						}
					>
						{busy ? (
							<>
								<Loader2 className="size-4 animate-spin" aria-hidden />
								{t("export.exporting")}
							</>
						) : (
							t("export.confirm")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function FormatButton({
	active,
	disabled,
	icon,
	label,
	onClick,
}: {
	active: boolean;
	disabled: boolean;
	icon: ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"flex items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-sm transition-colors",
				active
					? "border-primary bg-primary/10 text-foreground"
					: "border-border bg-background text-muted-foreground hover:bg-muted/60",
				disabled && "pointer-events-none opacity-60",
			)}
			aria-pressed={active}
		>
			{icon}
			{label}
		</button>
	);
}

function OptionRow({
	id,
	checked,
	disabled,
	label,
	description,
	onCheckedChange,
}: {
	id: string;
	checked: boolean;
	disabled: boolean;
	label: string;
	description: string;
	onCheckedChange: (v: boolean) => void;
}) {
	return (
		<div className="flex items-start gap-3">
			<Checkbox
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={(v) => onCheckedChange(v === true)}
				className="mt-0.5"
			/>
			<div className="min-w-0 flex-1">
				<Label htmlFor={id} className="font-medium text-sm leading-none">
					{label}
				</Label>
				<p className="mt-1 text-muted-foreground text-xs leading-snug">
					{description}
				</p>
			</div>
		</div>
	);
}
