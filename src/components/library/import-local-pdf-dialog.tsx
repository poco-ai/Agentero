import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { basenameOf } from "@/lib/core/path";
import { slugFromPdfPath, titleFromPdfPath } from "@/lib/paper/local-pdf-meta";
import type { LocalPdfImportEntry } from "@/lib/paper/lookup";

type DraftRow = {
	filePath: string;
	/** Original filename for UI + default title/id (not the staging path). */
	sourceName: string;
	title: string;
	authors: string;
	year: string;
	id: string;
};

export type ImportLocalPdfDraftItem = {
	path: string;
	sourceName: string;
};

function draftsFromItems(items: ImportLocalPdfDraftItem[]): DraftRow[] {
	return items.map((item) => {
		const nameForMeta = item.sourceName || item.path;
		return {
			filePath: item.path,
			sourceName: item.sourceName || basenameOf(item.path),
			title: titleFromPdfPath(nameForMeta),
			authors: "",
			year: "",
			id: slugFromPdfPath(nameForMeta),
		};
	});
}

/**
 * Confirm parent folder + per-PDF metadata before `paper_import_local_pdf`.
 * Opened when the user drops PDFs onto a `papers/` org folder or the Library.
 */
export function ImportLocalPdfDialog({
	open,
	onOpenChange,
	items,
	parentDir,
	onConfirm,
	busy,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	items: ImportLocalPdfDraftItem[];
	/** Vault-relative drop target, e.g. `papers` or `papers/nlp`. */
	parentDir: string;
	onConfirm: (entries: LocalPdfImportEntry[], parentDir: string) => void;
	busy?: boolean;
}) {
	const { t } = useTranslation("sidebar");
	const [rows, setRows] = useState<DraftRow[]>([]);
	const [dest, setDest] = useState(parentDir);

	useOverlayRegistration("import-local-pdf", open, () => onOpenChange(false));

	useEffect(() => {
		if (!open) return;
		setRows(draftsFromItems(items));
		setDest(parentDir || "papers");
	}, [open, items, parentDir]);

	const canSubmit = useMemo(() => {
		if (!rows.length || busy) return false;
		return rows.every(
			(r) => r.title.trim().length > 0 && r.id.trim().length > 0,
		);
	}, [rows, busy]);

	const updateRow = (index: number, patch: Partial<DraftRow>) => {
		setRows((prev) =>
			prev.map((r, i) => (i === index ? { ...r, ...patch } : r)),
		);
	};

	const handleConfirm = () => {
		if (!canSubmit) return;
		const entries: LocalPdfImportEntry[] = rows.map((r) => {
			const authors = r.authors
				.split(/[,;，；]/)
				.map((a) => a.trim())
				.filter(Boolean);
			const yearRaw = r.year.trim();
			const yearNum = yearRaw ? Number.parseInt(yearRaw, 10) : NaN;
			return {
				filePath: r.filePath,
				title: r.title.trim(),
				authors: authors.length ? authors : undefined,
				year: Number.isFinite(yearNum) ? yearNum : undefined,
				id: r.id.trim() || undefined,
			};
		});
		onConfirm(entries, dest.trim() || "papers");
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex max-h-[85vh] flex-col gap-3 sm:max-w-lg"
				aria-describedby={undefined}
			>
				<DialogHeader>
					<DialogTitle>
						{t("importLocalPdf.title", { count: items.length })}
					</DialogTitle>
				</DialogHeader>

				<div className="space-y-1.5">
					<Label htmlFor="import-pdf-parent" className="text-xs">
						{t("importLocalPdf.parentDir")}
					</Label>
					<Input
						id="import-pdf-parent"
						value={dest}
						onChange={(e) => setDest(e.target.value)}
						disabled={busy}
						spellCheck={false}
						className="font-mono text-xs"
					/>
					<p className="text-muted-foreground text-xs">
						{t("importLocalPdf.parentHint")}
					</p>
				</div>

				<ScrollArea className="min-h-0 max-h-[50vh] flex-1 pr-2">
					<div className="space-y-4">
						{rows.map((row, index) => (
							<div
								key={row.filePath}
								className="space-y-2 rounded-lg border border-border/80 p-3"
							>
								<p
									className="truncate font-medium text-muted-foreground text-xs"
									title={row.filePath}
								>
									{row.sourceName || basenameOf(row.filePath)}
								</p>
								<div className="space-y-1.5">
									<Label className="text-xs">
										{t("importLocalPdf.fieldTitle")}
									</Label>
									<Input
										value={row.title}
										onChange={(e) =>
											updateRow(index, { title: e.target.value })
										}
										disabled={busy}
									/>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<div className="space-y-1.5">
										<Label className="text-xs">
											{t("importLocalPdf.fieldAuthors")}
										</Label>
										<Input
											value={row.authors}
											onChange={(e) =>
												updateRow(index, { authors: e.target.value })
											}
											placeholder={t("importLocalPdf.authorsPlaceholder")}
											disabled={busy}
										/>
									</div>
									<div className="space-y-1.5">
										<Label className="text-xs">
											{t("importLocalPdf.fieldYear")}
										</Label>
										<Input
											value={row.year}
											onChange={(e) =>
												updateRow(index, { year: e.target.value })
											}
											inputMode="numeric"
											placeholder="2024"
											disabled={busy}
										/>
									</div>
								</div>
								<div className="space-y-1.5">
									<Label className="text-xs">
										{t("importLocalPdf.fieldId")}
									</Label>
									<Input
										value={row.id}
										onChange={(e) => updateRow(index, { id: e.target.value })}
										spellCheck={false}
										className="font-mono text-xs"
										disabled={busy}
									/>
								</div>
							</div>
						))}
					</div>
				</ScrollArea>

				<DialogFooter className="gap-2 sm:gap-0">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={busy}
					>
						{t("importLocalPdf.cancel")}
					</Button>
					<Button type="button" onClick={handleConfirm} disabled={!canSubmit}>
						{t("importLocalPdf.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
