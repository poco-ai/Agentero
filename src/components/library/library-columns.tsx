/**
 * Data-driven column layout + cell renderers for the papers library table.
 * Each entry pairs header meta (label / width / min-width) with a per-paper
 * cell renderer; the table body just walks visible columns.
 */
import { ArrowDown, ArrowUp, ArrowUpDown, FileWarning } from "lucide-react";
import type { ReactNode } from "react";
import {
	authorsCopyText,
	type CellCtx,
	type ColumnDef,
	identifierValue,
	type SortDir,
	type SortKey,
} from "@/components/library/library-row-utils";
import { PaperTagChip } from "@/components/library/paper-tag-chip";
import { ReadingTitleHeat } from "@/components/library/reading-heatmap";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import { formatAuthorsShort } from "@/lib/paper";

const COPY_CELL_BASE =
	"cursor-pointer rounded-sm hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Single-click-to-copy cell control shared by library columns. */
function CopyCellButton({
	copyText,
	labelKey,
	ctx,
	className,
	children,
}: {
	copyText: string | null | undefined;
	labelKey: string;
	ctx: Pick<CellCtx, "t" | "onCellCopy">;
	className?: string;
	children: ReactNode;
}) {
	const label = ctx.t(labelKey);
	const copyHint = ctx.t("papersLibrary.copyHint", { label });
	const canCopy = Boolean(copyText?.trim());
	return (
		<button
			type="button"
			className={cn(COPY_CELL_BASE, className)}
			title={canCopy ? copyHint : undefined}
			aria-label={copyHint}
			onClick={(e) => ctx.onCellCopy(e, copyText, label)}
		>
			{children}
		</button>
	);
}

/** `<td>` + copy button for plain columns (year / type / id …). */
function CopyTd({
	tdClassName,
	copyText,
	labelKey,
	ctx,
	buttonClassName,
	children,
}: {
	tdClassName: string;
	copyText: string | null | undefined;
	labelKey: string;
	ctx: Pick<CellCtx, "t" | "onCellCopy">;
	buttonClassName?: string;
	children: ReactNode;
}) {
	return (
		<td className={tdClassName}>
			<CopyCellButton
				copyText={copyText}
				labelKey={labelKey}
				ctx={ctx}
				className={buttonClassName}
			>
				{children}
			</CopyCellButton>
		</td>
	);
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
	if (!active) {
		return <ArrowUpDown className="size-3 shrink-0 opacity-40" aria-hidden />;
	}
	return dir === "asc" ? (
		<ArrowUp className="size-3 shrink-0 text-foreground" aria-hidden />
	) : (
		<ArrowDown className="size-3 shrink-0 text-foreground" aria-hidden />
	);
}

/** Column layout + cell renderers (data-driven; no switch in the component). */
export const COLUMN_META = {
	title: {
		labelKey: "papersLibrary.colTitle",
		widthWeight: 32,
		headerClassName: "min-w-[240px]",
		render: (p, ctx) => (
			<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5">
				<CopyCellButton
					copyText={p.title}
					labelKey="papersLibrary.colTitle"
					ctx={ctx}
					className="block w-full text-left font-medium"
				>
					<ReadingTitleHeat heatmap={ctx.heat} className="line-clamp-1">
						<span className="flex min-w-0 items-center gap-1">
							<span className="block truncate" title={p.title}>
								{p.title}
							</span>
							{p.has_pdf === false ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<span
											role="img"
											className="shrink-0 cursor-help text-muted-foreground"
											aria-label={ctx.t("papersLibrary.noLocalPdf")}
										>
											<FileWarning className="size-3" aria-hidden />
										</span>
									</TooltipTrigger>
									<TooltipContent>
										{ctx.t("papersLibrary.noLocalPdf")}
									</TooltipContent>
								</Tooltip>
							) : null}
						</span>
					</ReadingTitleHeat>
				</CopyCellButton>
			</td>
		),
	},
	authors: {
		labelKey: "papersLibrary.colAuthors",
		widthWeight: 18,
		headerClassName: "min-w-[140px]",
		render: (p, ctx) => (
			<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5 text-muted-foreground text-xs">
				<Tooltip>
					<TooltipTrigger asChild>
						<CopyCellButton
							copyText={authorsCopyText(p.authors)}
							labelKey="papersLibrary.colAuthors"
							ctx={ctx}
							className="block w-full text-left"
						>
							<span>{formatAuthorsShort(p.authors) || "—"}</span>
						</CopyCellButton>
					</TooltipTrigger>
					{p.authors && p.authors.length > 2 ? (
						<TooltipContent side="top" align="start" className="max-w-xs">
							{p.authors.join(", ")}
						</TooltipContent>
					) : null}
				</Tooltip>
			</td>
		),
	},
	year: {
		labelKey: "papersLibrary.colYear",
		widthWeight: 8,
		headerClassName: "min-w-16",
		render: (p, ctx) => (
			<CopyTd
				tdClassName="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground text-xs"
				copyText={p.year != null ? String(p.year) : null}
				labelKey="papersLibrary.colYear"
				ctx={ctx}
				buttonClassName="px-0.5"
			>
				{p.year ?? "—"}
			</CopyTd>
		),
	},
	publication: {
		labelKey: "papersLibrary.colPublication",
		widthWeight: 14,
		headerClassName: "min-w-[120px]",
		render: (p, ctx) => (
			<CopyTd
				tdClassName="min-w-0 max-w-0 overflow-hidden px-3 py-2.5 text-muted-foreground text-xs"
				copyText={p.publication || null}
				labelKey="papersLibrary.colPublication"
				ctx={ctx}
				buttonClassName="block w-full text-left"
			>
				<span className="line-clamp-1" title={p.publication ?? undefined}>
					{p.publication || "—"}
				</span>
			</CopyTd>
		),
	},
	tags: {
		labelKey: "papersLibrary.colTags",
		widthWeight: 18,
		headerClassName: "min-w-[120px]",
		render: (_p, { t, onCellCopy, tags }) => {
			const label = t("papersLibrary.colTags");
			const hint = t("papersLibrary.copyHint", { label });
			return (
				<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5">
					{tags.length ? (
						<div className="flex flex-wrap gap-1">
							{tags.map((tag) => (
								<PaperTagChip
									key={tag.name}
									tag={tag}
									title={hint}
									aria-label={t("papersLibrary.copyHint", {
										label: tag.name,
									})}
									onClick={(e) => onCellCopy(e, tag.name, label)}
								/>
							))}
						</div>
					) : (
						<span className="text-muted-foreground text-xs">—</span>
					)}
				</td>
			);
		},
	},
	id: {
		labelKey: "papersLibrary.colId",
		widthWeight: 14,
		headerClassName: "min-w-[160px]",
		render: (p, ctx) => {
			const value = identifierValue(p);
			return (
				<CopyTd
					tdClassName="min-w-0 max-w-0 overflow-hidden px-3 py-2.5 font-mono text-muted-foreground text-xs"
					copyText={value}
					labelKey="papersLibrary.colId"
					ctx={ctx}
					buttonClassName="block w-full text-left"
				>
					<span className="line-clamp-1" title={value ?? undefined}>
						{value ?? "—"}
					</span>
				</CopyTd>
			);
		},
	},
} as const satisfies Record<SortKey, ColumnDef>;

export { SortIcon };
