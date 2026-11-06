/**
 * Data-driven column layout + cell renderers for the papers library table.
 * Each entry pairs header meta (label / width / min-width) with a per-paper
 * cell renderer; the table body just walks visible columns.
 */
import { ArrowDown, ArrowUp, ArrowUpDown, FileWarning } from "lucide-react";
import type { ReactNode } from "react";
import { LibraryPaperTag } from "@/components/library/library-paper-tag";
import {
	addedDate,
	authorsCopyText,
	type BuiltinLibraryColumnKey,
	type CellCtx,
	type ColumnDef,
	identifierValue,
	isMissingLocalPdf,
	type SortDir,
	type SortKey,
} from "@/components/library/library-row-utils";
import { ReadingTitleHeat } from "@/components/library/reading-heatmap";
import { PaperTitle } from "@/components/paper/paper-title";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import {
	formatAuthorsShort,
	type PaperLibraryRow,
	publicationDateText,
} from "@/lib/paper";
import { type VenueStatus, venueInfo } from "@/lib/paper/venue-info";

const COPY_CELL_BASE =
	"cursor-pointer select-text rounded-sm hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Double-click-to-copy cell control shared by library columns. */
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
			onDoubleClick={() => ctx.onCellCopy(copyText, label)}
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

const VENUE_STATUS_LABEL: Record<VenueStatus, string> = {
	published: "papersLibrary.venueStatus.published",
	submitted: "papersLibrary.venueStatus.submitted",
	preprint: "papersLibrary.venueStatus.preprint",
	none: "papersLibrary.colPublication",
};

const VENUE_STATUS_CLASS: Record<VenueStatus, string> = {
	published: "bg-muted text-foreground",
	submitted: "bg-muted/70 text-muted-foreground",
	preprint: "bg-muted/40 text-muted-foreground",
	none: "bg-muted/40 text-muted-foreground",
};

/** One cell for publication / submission / preprint + EasyScholar metrics. */
function VenueCell({ paper, ctx }: { paper: PaperLibraryRow; ctx: CellCtx }) {
	const info = venueInfo(paper);
	if (info.status === "none" || !info.name) {
		return (
			<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5 text-muted-foreground text-xs">
				—
			</td>
		);
	}
	const metrics = info.metrics.join(" · ");
	return (
		<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5">
			<CopyCellButton
				copyText={info.name}
				labelKey="papersLibrary.colPublication"
				ctx={ctx}
				className="block w-full text-left"
			>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="flex min-w-0 items-center gap-1.5">
						<span
							className={cn(
								"shrink-0 rounded px-1 py-0.5 text-[10px] leading-none",
								VENUE_STATUS_CLASS[info.status],
							)}
						>
							{ctx.t(VENUE_STATUS_LABEL[info.status])}
						</span>
						<span
							className="truncate text-foreground text-xs"
							title={info.fullName ?? undefined}
						>
							{info.name}
						</span>
					</span>
					{metrics ? (
						<span
							className="truncate text-[10px] text-muted-foreground/80"
							title={metrics}
						>
							{metrics}
						</span>
					) : null}
					{info.inferred ? (
						<span className="text-[10px] text-muted-foreground/70">
							{ctx.t("papersLibrary.venueStatus.inferred")}
						</span>
					) : null}
				</span>
			</CopyCellButton>
		</td>
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
							<PaperTitle text={p.title} className="block min-w-0 truncate" />
							{isMissingLocalPdf(p) ? (
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
	date: {
		labelKey: "papersLibrary.colDate",
		widthWeight: 10,
		headerClassName: "min-w-[92px]",
		render: (p) => (
			<td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground text-xs">
				{publicationDateText(p) || "—"}
			</td>
		),
	},
	addedAt: {
		labelKey: "papersLibrary.colAddedAt",
		widthWeight: 10,
		headerClassName: "min-w-[6.5rem]",
		render: (p) => {
			const date = addedDate(p.added_at);
			const text = date
				? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
				: "—";
			return (
				<td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground text-xs">
					<time dateTime={date?.toISOString()} title={date?.toLocaleString()}>
						{text}
					</time>
				</td>
			);
		},
	},
	publication: {
		labelKey: "papersLibrary.colPublication",
		widthWeight: 14,
		headerClassName: "min-w-[120px]",
		render: (p, ctx) => <VenueCell paper={p} ctx={ctx} />,
	},
	tags: {
		labelKey: "papersLibrary.colTags",
		widthWeight: 18,
		headerClassName: "min-w-[120px]",
		render: (p, { tags }) => (
			<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5">
				{tags.length ? (
					<div className="flex flex-wrap gap-1">
						{tags.map((tag) => (
							<LibraryPaperTag key={tag.name} paper={p} tag={tag} />
						))}
					</div>
				) : (
					<span className="text-muted-foreground text-xs">—</span>
				)}
			</td>
		),
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
	citations: {
		labelKey: "papersLibrary.colCitations",
		widthWeight: 10,
		headerClassName: "min-w-[80px]",
		render: (p) => {
			const count = p.citation_count;
			return (
				<td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
					{count != null ? new Intl.NumberFormat(undefined).format(count) : "—"}
				</td>
			);
		},
	},
} as const satisfies Record<BuiltinLibraryColumnKey, ColumnDef>;

export { SortIcon };

import { SelectCell } from "@/components/library/select-cell";
import { TextCell } from "@/components/library/text-cell";
import {
	customPropertiesStore,
	propertyType,
} from "@/lib/paper/custom-properties-store";

export function getColumnMeta(key: SortKey): ColumnDef {
	if (Object.hasOwn(COLUMN_META, key)) {
		return COLUMN_META[key as BuiltinLibraryColumnKey];
	}
	if (key.startsWith("prop:")) {
		const propId = key.slice(5);
		const prop = customPropertiesStore
			.getState()
			.properties.find((p) => p.id === propId);
		return {
			labelKey: prop?.name ?? propId,
			widthWeight: 14,
			headerClassName: "min-w-[120px]",
			render: (p) => {
				if (!prop) {
					return (
						<td className="px-3 py-2.5 text-muted-foreground text-xs">—</td>
					);
				}
				return (
					<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5">
						{propertyType(prop) === "text" ? (
							<TextCell
								paperPath={p.path ?? ""}
								property={prop}
								value={p.custom_props?.[prop.id]}
							/>
						) : (
							<SelectCell
								paperPath={p.path ?? ""}
								property={prop}
								selectedOptionId={p.custom_props?.[prop.id]}
							/>
						)}
					</td>
				);
			},
		};
	}
	return {
		labelKey: key,
		widthWeight: 10,
		headerClassName: "min-w-[100px]",
		render: () => (
			<td className="px-3 py-2.5 text-xs text-muted-foreground">—</td>
		),
	};
}
