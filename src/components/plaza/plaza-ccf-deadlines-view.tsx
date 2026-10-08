/**
 * Native 广场 panel: upcoming CCF conference deadlines.
 *
 * A flat "what's due next" list sourced entirely from the upstream
 * ccf-deadlines dataset (see `lib/plaza/ccf-deadlines.ts`). Each row keeps only
 * the CCF rank, the submission deadline and the official site link.
 */

import { ExternalLink, Loader2 } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
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

/**
 * Monochrome rank ramp (no colour): A carries the most weight, N the least, so
 * the list stays scannable without a rainbow of badges.
 */
const RANK_CLASS: Record<CcfRank, string> = {
	A: "bg-foreground text-background",
	B: "bg-foreground/15 text-foreground",
	C: "bg-foreground/5 text-muted-foreground",
	N: "text-muted-foreground/70",
};

const SEGMENT_CLASS =
	"inline-flex h-6 min-w-6 items-center justify-center rounded-md px-2 font-medium text-caption tabular-nums transition-[color,background-color,transform] duration-[var(--motion-duration-micro)] ease-[var(--motion-ease-out)] active:scale-[0.96] motion-reduce:transition-none";

export function PlazaCcfDeadlinesView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [items, setItems] = useState<CcfDeadlineItem[]>([]);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState(false);
	const [rankFilter, setRankFilter] = useState<CcfRank[]>([]);
	const loadedRef = useRef(false);

	const load = useCallback(async () => {
		setBusy(true);
		try {
			setItems(await loadCcfDeadlines());
			setError(false);
		} catch (err) {
			setError(true);
			notifyError(errorText(err) || t("plaza.ccfDeadlines.loadFailed"));
		} finally {
			setBusy(false);
		}
	}, [t]);

	// Refresh on every open.
	useEffect(() => {
		if (loadedRef.current) return;
		loadedRef.current = true;
		void load();
	}, [load]);

	const visible =
		rankFilter.length === 0
			? items
			: items.filter((item) => rankFilter.includes(item.rank));

	const toggleRank = (rank: CcfRank) =>
		setRankFilter((prev) =>
			prev.includes(rank) ? prev.filter((r) => r !== rank) : [...prev, rank],
		);

	return (
		<div className={cn("relative flex h-full min-h-0 flex-col", className)}>
			<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto">
				{/* Translucent chrome: rows scroll under it (Apple material). */}
				<div
					data-plaza-header
					className="sticky top-0 z-10 flex items-center gap-2 bg-background/72 px-2.5 py-2 shadow-[0_1px_0_0_color-mix(in_oklch,var(--border)_55%,transparent)] backdrop-blur-xl backdrop-saturate-150 supports-backdrop-blur:bg-background/60 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-gradient-to-b after:from-background/80 after:to-transparent after:content-['']"
				>
					<RankFilter
						selected={rankFilter}
						onToggle={toggleRank}
						onClear={() => setRankFilter([])}
					/>
				</div>

				<div className="p-1.5">
					{busy && items.length === 0 ? (
						<div className="flex items-center justify-center py-10 text-muted-foreground text-xs">
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
		<div className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-[var(--motion-duration-micro)] hover:bg-muted/60 motion-reduce:transition-none">
			<span
				className={cn(
					"inline-flex size-5 shrink-0 items-center justify-center rounded-md font-semibold text-caption tabular-nums",
					RANK_CLASS[item.rank],
				)}
				title={`CCF ${item.rank}`}
			>
				{item.rank}
			</span>
			<span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
			{item.estimated ? (
				<span
					className="shrink-0 rounded border border-border/60 px-1 text-caption text-muted-foreground/70"
					title={t("plaza.ccfDeadlines.estimatedHint")}
				>
					{t("plaza.ccfDeadlines.estimated")}
				</span>
			) : null}
			{item.year ? (
				<span className="shrink-0 text-caption tabular-nums text-muted-foreground">
					{item.year}
				</span>
			) : null}
			{item.comment ? (
				<span className="hidden min-w-0 truncate text-caption text-muted-foreground/80 md:inline">
					{item.comment}
				</span>
			) : null}
			<span className="ml-auto flex shrink-0 items-center gap-2">
				<span className="font-mono text-caption tabular-nums text-muted-foreground/70">
					{item.deadline.slice(0, 16)}
					{item.timezone ? (
						<span className="ml-1 text-muted-foreground/50">
							{item.timezone}
						</span>
					) : null}
				</span>
				{countdown ? (
					<span
						className={cn(
							"w-14 whitespace-nowrap text-right text-caption tabular-nums",
							urgent
								? "font-semibold text-foreground"
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

/**
 * Segmented control for the rank filter. Multi-select: tapping a rank toggles
 * it; the leading "all" segment clears the selection. The selected segment uses
 * a foreground-alpha fill so it contrasts with the track in both themes.
 */
function RankFilter({
	selected,
	onToggle,
	onClear,
}: {
	selected: readonly CcfRank[];
	onToggle: (rank: CcfRank) => void;
	onClear: () => void;
}) {
	const { t } = useTranslation("sidebar");
	const allActive = selected.length === 0;
	return (
		<fieldset className="m-0 flex items-center gap-0.5 rounded-lg bg-foreground/5 p-0.5">
			<legend className="sr-only">{t("plaza.ccfDeadlines.filterLabel")}</legend>
			<Segment active={allActive} onClick={onClear}>
				{t("plaza.ccfDeadlines.rankAll")}
			</Segment>
			{RANKS.map((rank) => (
				<Segment
					key={rank}
					active={selected.includes(rank)}
					onClick={() => onToggle(rank)}
				>
					{rank}
				</Segment>
			))}
		</fieldset>
	);
}

function Segment({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				SEGMENT_CLASS,
				active
					? "bg-foreground/15 text-foreground"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}
