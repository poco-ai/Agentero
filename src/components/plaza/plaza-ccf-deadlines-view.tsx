/**
 * Native 广场 panel: upcoming CCF conference deadlines.
 *
 * A flat "what's due next" list sourced entirely from the upstream
 * ccf-deadlines dataset (see `lib/plaza/ccf-deadlines.ts`). Each row keeps only
 * the CCF rank, the submission deadline and the official site link.
 */

import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatLocaleTimestamp } from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import {
	type CcfDeadlineItem,
	type CcfRank,
	loadCcfDeadlines,
} from "@/lib/plaza/ccf-deadlines";

const RANKS: readonly CcfRank[] = ["A", "B", "C", "N"];

/** Rank filter value: a single CCF rank, or every rank. */
type RankFilterValue = CcfRank | "all";

export function PlazaCcfDeadlinesView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [items, setItems] = useState<CcfDeadlineItem[]>([]);
	const [fetchedAt, setFetchedAt] = useState<number | null>(null);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState(false);
	const [rankFilter, setRankFilter] = useState<RankFilterValue>("all");
	const loadedRef = useRef(false);

	const load = useCallback(
		async (force: boolean) => {
			setBusy(true);
			try {
				const result = await loadCcfDeadlines({ force });
				setItems(result.items);
				setFetchedAt(result.fetchedAt);
				setError(false);
			} catch (err) {
				setError(true);
				notifyError(errorText(err) || t("plaza.ccfDeadlines.loadFailed"));
			} finally {
				setBusy(false);
			}
		},
		[t],
	);

	useEffect(() => {
		if (loadedRef.current) return;
		loadedRef.current = true;
		void load(false);
	}, [load]);

	const visible =
		rankFilter === "all"
			? items
			: items.filter((item) => item.rank === rankFilter);

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			<div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-2.5 py-2">
				<RankFilter value={rankFilter} onChange={setRankFilter} />
				<span className="ml-auto min-w-0 truncate text-caption text-muted-foreground">
					{fetchedAt
						? t("plaza.ccfDeadlines.updated", {
								time: formatLocaleTimestamp(fetchedAt),
							})
						: ""}
				</span>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							disabled={busy}
							aria-label={t("plaza.ccfDeadlines.refresh")}
							onClick={() => void load(true)}
						>
							{busy ? (
								<Loader2 className="size-3.5 animate-spin" aria-hidden />
							) : (
								<RefreshCw className="size-3.5" aria-hidden />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("plaza.ccfDeadlines.refresh")}</TooltipContent>
				</Tooltip>
			</div>

			<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
				{busy && items.length === 0 ? (
					<div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-xs">
						<Loader2 className="size-3.5 animate-spin" aria-hidden />
					</div>
				) : visible.length === 0 ? (
					<p className="py-10 text-center text-muted-foreground text-xs">
						{items.length === 0
							? t(
									error
										? "plaza.ccfDeadlines.loadFailed"
										: "plaza.ccfDeadlines.empty",
								)
							: t("plaza.ccfDeadlines.emptyFiltered")}
					</p>
				) : (
					visible.map((item) => <DeadlineRow key={item.key} item={item} />)
				)}
			</div>
		</div>
	);
}

function DeadlineRow({ item }: { item: CcfDeadlineItem }) {
	const { t } = useTranslation("sidebar");
	const days =
		item.at === null ? null : Math.ceil((item.at - Date.now()) / 86_400_000);
	const urgent = days !== null && days <= 3;
	const countdown =
		days === null
			? null
			: days <= 0
				? t("plaza.ccfDeadlines.today")
				: t("plaza.ccfDeadlines.daysLeft", { days });

	return (
		<div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
			<span
				className="inline-flex size-5 shrink-0 items-center justify-center rounded border border-border bg-muted font-semibold text-caption text-muted-foreground"
				title={`CCF ${item.rank}`}
			>
				{item.rank}
			</span>
			<span className="min-w-0 truncate text-sm">
				<span className="font-medium">{item.title}</span>
				{item.year ? (
					<span className="ml-1 text-muted-foreground tabular-nums">
						{item.year}
					</span>
				) : null}
			</span>
			{item.comment ? (
				<span className="hidden min-w-0 truncate text-caption text-muted-foreground md:inline">
					{item.comment}
				</span>
			) : null}
			<span className="ml-auto flex shrink-0 items-center gap-2">
				<span className="font-mono text-caption text-muted-foreground">
					{item.deadline.slice(0, 16)}
					{item.timezone ? <span className="ml-1">{item.timezone}</span> : null}
				</span>
				{countdown ? (
					<span
						className={cn(
							"w-10 text-right text-caption tabular-nums",
							urgent
								? "font-medium text-amber-600 dark:text-amber-400"
								: "text-muted-foreground",
						)}
					>
						{countdown}
					</span>
				) : null}
				{item.link ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("plaza.ccfDeadlines.openOfficial")}
								onClick={() => openExternalUrl(item.link)}
							>
								<ExternalLink className="size-3.5" aria-hidden />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("plaza.ccfDeadlines.openOfficial")}
						</TooltipContent>
					</Tooltip>
				) : (
					<span className="size-6" aria-hidden />
				)}
			</span>
		</div>
	);
}

/** Compact CCF-rank selector for the panel header. */
function RankFilter({
	value,
	onChange,
}: {
	value: RankFilterValue;
	onChange: (value: RankFilterValue) => void;
}) {
	const { t } = useTranslation("sidebar");
	const options: readonly RankFilterValue[] = ["all", ...RANKS];
	return (
		<fieldset className="m-0 flex items-center gap-1 border-0 p-0">
			<legend className="sr-only">{t("plaza.ccfDeadlines.filterLabel")}</legend>
			{options.map((option) => {
				const active = value === option;
				return (
					<button
						key={option}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(option)}
						className={cn(
							"inline-flex h-5 min-w-5 items-center justify-center rounded-full border px-1.5 font-medium text-caption transition-colors",
							active
								? "border-primary/50 bg-primary/10 text-foreground"
								: "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
						)}
					>
						{option === "all" ? t("plaza.ccfDeadlines.rankAll") : option}
					</button>
				);
			})}
		</fieldset>
	);
}
