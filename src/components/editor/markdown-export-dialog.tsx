"use client";

import { FileImage, FileText, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import type {
	MarkdownExportFormat,
	MarkdownExportOptions,
	MarkdownExportPaperHeader,
} from "@/lib/markdown/export/types";

const FORMAT_OPTIONS: {
	value: MarkdownExportFormat;
	icon: typeof FileText;
	labelKey: "export.formatPdf" | "export.formatPng";
}[] = [
	{ value: "pdf", icon: FileText, labelKey: "export.formatPdf" },
	{ value: "png", icon: FileImage, labelKey: "export.formatPng" },
];

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
					<div className="flex items-center gap-3">
						<span
							className="shrink-0 font-medium text-sm"
							id="export-format-label"
						>
							{t("export.format")}
						</span>
						<Select
							value={format}
							disabled={busy}
							onValueChange={(value) => {
								if (value === "pdf" || value === "png") setFormat(value);
							}}
						>
							<SelectTrigger aria-labelledby="export-format-label">
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper" align="start">
								{FORMAT_OPTIONS.map((opt) => {
									const Icon = opt.icon;
									return (
										<SelectItem key={opt.value} value={opt.value}>
											<span className="flex items-center gap-1.5">
												<Icon className="size-4" aria-hidden />
												{t(opt.labelKey)}
											</span>
										</SelectItem>
									);
								})}
							</SelectContent>
						</Select>
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
								description={t("export.includePaperHeaderHint")}
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
