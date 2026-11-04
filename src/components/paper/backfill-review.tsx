import { ChevronDown, Download, FileText, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { BackfillPreview } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";

export function BackfillSummary({ preview }: { preview: BackfillPreview }) {
	const { t } = useTranslation("settings");
	const rows = [
		preview.downloadSource > 0
			? t("doctor.backfill.downloadCount", { count: preview.downloadSource })
			: null,
		preview.parseBody > 0
			? t("doctor.backfill.parseCount", { count: preview.parseBody })
			: null,
		preview.repairState > 0
			? t("doctor.backfill.repairCount", { count: preview.repairState })
			: null,
	].filter((row): row is string => Boolean(row));
	return (
		<div className="space-y-1.5 text-muted-foreground text-xs leading-relaxed">
			{rows.map((row) => (
				<p key={row}>{row}</p>
			))}
		</div>
	);
}

/** Shared review list for the startup reminder and the inline Doctor section. */
export function BackfillReview({
	preview,
	onStart,
	onLater,
	collapsible = false,
}: {
	preview: BackfillPreview;
	onStart: (paths: string[]) => Promise<void>;
	onLater?: () => void;
	collapsible?: boolean;
}) {
	const { t } = useTranslation("settings");
	const id = useId();
	const papers = preview.papers.filter(
		(paper) => paper.reason !== "repairState",
	);
	const [selected, setSelected] = useState(
		() => new Set(papers.map((paper) => paper.path)),
	);
	const [busy, setBusy] = useState(false);
	const selectionLabel = t("doctor.backfill.selection", {
		selected: selected.size,
		total: papers.length,
	});
	return (
		<>
			<Collapsible defaultOpen={!collapsible}>
				{collapsible && (
					<CollapsibleTrigger className="group mt-3 flex w-full items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs font-medium tabular-nums outline-none transition-colors hover:bg-muted/60 data-[state=open]:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50">
						{selectionLabel}
						<ChevronDown className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
					</CollapsibleTrigger>
				)}
				<CollapsibleContent>
					<div className="mt-2 overflow-hidden rounded-lg border border-border/70 bg-muted/20">
						<div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 text-xs">
							<label
								htmlFor={`${id}-all`}
								className="flex cursor-pointer items-center gap-2"
							>
								<Checkbox
									id={`${id}-all`}
									disabled={busy}
									checked={
										papers.length > 0 && selected.size === papers.length
											? true
											: selected.size
												? "indeterminate"
												: false
									}
									onCheckedChange={(checked) =>
										setSelected(
											checked === true
												? new Set(papers.map((paper) => paper.path))
												: new Set(),
										)
									}
								/>
								{t("doctor.backfill.selectAll")}
							</label>
							{!collapsible && (
								<span className="text-muted-foreground tabular-nums">
									{selectionLabel}
								</span>
							)}
						</div>
						<div className="max-h-[min(17rem,40vh)] overflow-y-auto overflow-x-hidden overscroll-contain">
							{papers.map((paper) => (
								<label
									key={paper.path}
									htmlFor={`${id}-${paper.path}`}
									className="flex cursor-pointer items-start gap-2.5 border-b border-border/50 px-3 py-2.5 transition-colors last:border-b-0 hover:bg-muted/40"
								>
									<Checkbox
										id={`${id}-${paper.path}`}
										className="mt-0.5"
										disabled={busy}
										checked={selected.has(paper.path)}
										onCheckedChange={(checked) =>
											setSelected((current) => {
												const next = new Set(current);
												if (checked === true) next.add(paper.path);
												else next.delete(paper.path);
												return next;
											})
										}
									/>
									<span className="min-w-0 flex-1">
										<span
											className="block truncate text-sm font-medium leading-snug"
											title={paper.title}
										>
											{paper.title}
										</span>
										<span className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
											{paper.reason === "downloadSource" ? (
												<Download className="size-3 shrink-0" />
											) : (
												<FileText className="size-3 shrink-0" />
											)}
											<span className="shrink-0">
												{t(
													paper.reason === "downloadSource"
														? "doctor.backfill.reasons.downloadSource"
														: "doctor.backfill.reasons.parseBody",
												)}
											</span>
											<span aria-hidden className="text-border">
												·
											</span>
											<span
												className="truncate font-mono text-[11px]"
												title={paper.path}
											>
												{paper.path}
											</span>
										</span>
									</span>
								</label>
							))}
						</div>
					</div>
				</CollapsibleContent>
			</Collapsible>
			<div className="mt-3 flex items-center justify-end gap-2 border-border/60 border-t pt-3">
				{onLater && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={onLater}
					>
						{t("doctor.backfill.later")}
					</Button>
				)}
				<Button
					type="button"
					size="sm"
					disabled={busy || selected.size === 0}
					onClick={async () => {
						setBusy(true);
						try {
							await onStart([...selected]);
						} catch (error) {
							notifyError(errorText(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy && <Loader2 className="animate-spin" />}
					{t("doctor.backfill.start")}
				</Button>
			</div>
		</>
	);
}
