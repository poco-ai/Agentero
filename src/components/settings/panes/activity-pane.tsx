import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ActivityHeatmap,
	ActivityWeekBars,
	ActivityWorkflows,
	durationText,
} from "@/components/settings/activity/activity-charts";
import {
	PageTitle,
	settingsCardClassName,
} from "@/components/settings/settings-layout";
import type { UsageBoard } from "@/lib/activity/api";
import { fetchUsageBoard } from "@/lib/activity/api";
import {
	type ActivityMetric,
	boardQueryRange,
	formatTokenCount,
	paperLabel,
	sumDays,
	tokensReported,
} from "@/lib/activity/board";
import { track } from "@/lib/activity/track";
import type { UiRequestPayload } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

const EMPTY_BOARD: UsageBoard = {
	days: [],
	papers: [],
	workflows: [],
	weekPaperCount: 0,
};

function weekStartsOnFor(language: string): 0 | 1 {
	return language.toLowerCase().startsWith("zh") ? 1 : 0;
}

export function ActivityPane({ vaultPath }: { vaultPath?: string | null }) {
	const { t, i18n } = useTranslation("settings");
	const [board, setBoard] = useState<UsageBoard>(EMPTY_BOARD);
	const [metric, setMetric] = useState<ActivityMetric>("reading");
	const [today] = useState(() => new Date());
	const remote = Boolean(vaultPath && isRemoteVaultHandle(vaultPath));
	const weekStartsOn = weekStartsOnFor(i18n.language);

	useEffect(() => {
		track("activity.view");
	}, []);

	useEffect(() => {
		if (!vaultPath || remote) return;
		const range = boardQueryRange(today, weekStartsOn);
		let cancelled = false;
		void fetchUsageBoard({
			vault: vaultPath,
			startDay: range.startDay,
			endDay: range.endDay,
			weekStart: range.weekStart,
		})
			.then((next) => {
				if (!cancelled) setBoard(next);
			})
			.catch((error) => {
				if (!cancelled) notifyError(errorText(error));
			});
		return () => {
			cancelled = true;
		};
	}, [remote, today, vaultPath, weekStartsOn]);

	const range = boardQueryRange(today, weekStartsOn);
	const reading = sumDays(
		board.days,
		range.weekStart,
		range.endDay,
		(day) => day.readingMs,
	);
	const previousReading = sumDays(
		board.days,
		range.prevStart,
		range.prevEnd,
		(day) => day.readingMs,
	);
	const runs = sumDays(
		board.days,
		range.weekStart,
		range.endDay,
		(day) => day.agentRuns,
	);
	const previousRuns = sumDays(
		board.days,
		range.prevStart,
		range.prevEnd,
		(day) => day.agentRuns,
	);
	const tokens = sumDays(
		board.days,
		range.weekStart,
		range.endDay,
		(day) => day.tokens,
	);
	const previousTokens = sumDays(
		board.days,
		range.prevStart,
		range.prevEnd,
		(day) => day.tokens,
	);
	const reported = tokensReported(board);
	/** Whole-window totals anchor the six-month heatmap. */
	const periodReading = sumDays(
		board.days,
		range.startDay,
		range.endDay,
		(day) => day.readingMs,
	);
	const periodTokens = sumDays(
		board.days,
		range.startDay,
		range.endDay,
		(day) => day.tokens,
	);
	const periodValue =
		metric === "reading"
			? durationText(t, periodReading)
			: reported
				? formatTokenCount(periodTokens)
				: t("activity.week.unreported");

	const weekStats: {
		label: string;
		value: string;
		delta?: number;
		deltaText?: string;
	}[] = [
		{
			label: t("activity.week.reading"),
			value: durationText(t, reading),
			delta: reading - previousReading,
			deltaText: durationText(t, Math.abs(reading - previousReading)),
		},
		{
			label: t("activity.week.papers"),
			value: String(board.weekPaperCount),
		},
		{
			label: t("activity.week.agent"),
			value: String(runs),
			delta: runs - previousRuns,
			deltaText: String(Math.abs(runs - previousRuns)),
		},
		{
			label: t("activity.week.tokens"),
			value: reported
				? formatTokenCount(tokens)
				: t("activity.week.unreported"),
			delta: reported ? tokens - previousTokens : undefined,
			deltaText: formatTokenCount(Math.abs(tokens - previousTokens)),
		},
	];

	const showWorkflows = board.workflows.length > 0;
	const showPapers = board.papers.length > 0;

	return (
		<div className="flex flex-col gap-6">
			<PageTitle className="mb-0" title={t("activity.title")} />

			{/* Six-month overview: the page's headline is the heatmap, not the cards. */}
			<section className={cn(settingsCardClassName, "p-4 sm:p-5")}>
				<div className="flex items-center justify-between gap-3">
					<h3 className="min-w-0 font-semibold text-sm">
						{t("activity.heatmap.reading")}
					</h3>
					<MetricSwitch value={metric} onChange={setMetric} />
				</div>
				<div className="mt-2.5 flex items-baseline gap-1.5">
					<span className="font-medium text-[11px] text-muted-foreground">
						{t(
							metric === "reading"
								? "activity.metric.reading"
								: "activity.metric.tokens",
						)}
					</span>
					<span className="truncate font-semibold text-lg tabular-nums">
						{periodValue}
					</span>
				</div>
				<div className="mt-3">
					<ActivityHeatmap
						days={board.days}
						today={today}
						weekStartsOn={weekStartsOn}
						metric={metric}
					/>
				</div>
			</section>

			{/* This week's detail sits under its own label so the two periods never mix. */}
			<section className="flex flex-col gap-2">
				<h3 className="px-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
					{t("activity.thisWeek")}
				</h3>
				<div className={cn(settingsCardClassName, "@container/board")}>
					<div className="grid grid-cols-2 @[560px]/board:grid-cols-4">
						{weekStats.map((stat, index) => (
							<div
								key={stat.label}
								className={cn(
									"min-w-0 border-border/60 px-4 py-3.5",
									index % 2 === 1 && "border-l",
									index > 0 && "@[560px]/board:border-l",
									index >= 2 && "border-t @[560px]/board:border-t-0",
								)}
							>
								<p className="truncate font-medium text-[11px] text-muted-foreground">
									{stat.label}
								</p>
								<p className="mt-1 truncate font-semibold text-base tabular-nums">
									{stat.value}
								</p>
								<StatDelta delta={stat.delta} deltaText={stat.deltaText} />
							</div>
						))}
					</div>
					<div className="border-t border-border/60 px-4 py-4">
						<ActivityWeekBars
							days={board.days}
							today={today}
							weekStartsOn={weekStartsOn}
							metric={metric}
						/>
					</div>
				</div>
			</section>

			<div
				className={cn(
					"grid items-stretch gap-4",
					showWorkflows && showPapers && "sm:grid-cols-2",
				)}
			>
				{showWorkflows && (
					<section className={cn(settingsCardClassName, "flex flex-col p-4")}>
						<h3 className="font-semibold text-sm">{t("activity.workflows")}</h3>
						<div className="mt-3 flex-1">
							<ActivityWorkflows board={board} />
						</div>
					</section>
				)}
				{showPapers && (
					<section className={cn(settingsCardClassName, "flex flex-col p-4")}>
						<h3 className="font-semibold text-sm">{t("activity.papers")}</h3>
						<ol className="-mx-1 mt-1 flex flex-col">
							{board.papers.map((paper, index) => (
								<li key={paper.path}>
									<button
										type="button"
										className="group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring"
										onClick={() => {
											if (!vaultPath) return;
											void openActivityPaper(
												vaultPath,
												paper.path,
												t("activity.openFailed"),
											);
										}}
									>
										<span className="w-3.5 shrink-0 text-right font-medium text-[11px] text-muted-foreground tabular-nums">
											{index + 1}
										</span>
										<span className="min-w-0 flex-1 truncate text-sm group-hover:underline">
											{paperLabel(paper.path, paper.title)}
										</span>
										<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
											{durationText(t, paper.readingMs)}
										</span>
									</button>
								</li>
							))}
						</ol>
					</section>
				)}
			</div>
		</div>
	);
}

/** Week-over-week change; more usage reads as a cost, so up is destructive. */
function StatDelta({
	delta,
	deltaText,
}: {
	delta?: number;
	deltaText?: string;
}) {
	if (delta == null || delta === 0 || !deltaText) {
		return <p className="mt-1 text-[11px] leading-[11px]">&nbsp;</p>;
	}
	return (
		<p
			className={cn(
				"mt-1 truncate text-[11px] tabular-nums leading-[11px]",
				delta > 0 ? "text-destructive" : "text-success",
			)}
		>
			{`${delta > 0 ? "+" : "−"}${deltaText}`}
		</p>
	);
}

/**
 * Reading / token switch as an Apple-style segmented control: one sliding
 * indicator, interruptible, and reduced-motion friendly.
 */
function MetricSwitch({
	value,
	onChange,
}: {
	value: ActivityMetric;
	onChange: (next: ActivityMetric) => void;
}) {
	const { t } = useTranslation("settings");
	const reduceMotion = useReducedMotion();
	const options: { value: ActivityMetric; label: string }[] = [
		{ value: "reading", label: t("activity.metric.reading") },
		{ value: "tokens", label: t("activity.metric.tokens") },
	];
	return (
		<div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5">
			{options.map((option) => {
				const selected = value === option.value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={selected}
						onClick={() => onChange(option.value)}
						className={cn(
							"relative rounded-[7px] px-2.5 py-1 font-medium text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
							selected
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{selected ? (
							<motion.span
								layoutId="activity-metric-indicator"
								aria-hidden
								className="absolute inset-0 rounded-[7px] bg-background shadow-raised"
								transition={
									reduceMotion
										? { duration: 0 }
										: { type: "spring", bounce: 0.15, duration: 0.3 }
								}
							/>
						) : null}
						<span className="relative">{option.label}</span>
					</button>
				);
			})}
		</div>
	);
}

/** Ask the main window to open this paper, then bring that window forward. */
async function openActivityPaper(
	vaultPath: string,
	path: string,
	failure: string,
): Promise<void> {
	try {
		const [{ emitTo }, { WebviewWindow }] = await Promise.all([
			import("@tauri-apps/api/event"),
			import("@tauri-apps/api/webviewWindow"),
		]);
		const main = await WebviewWindow.getByLabel("main");
		if (!main) {
			notifyError(failure);
			return;
		}
		const request: UiRequestPayload = {
			action: "open-paper",
			vaultPath,
			path,
		};
		await emitTo("main", "ui:request", request);
		try {
			await main.setFocus();
		} catch {
			// The paper still opens when the main window cannot take focus.
		}
	} catch (error) {
		notifyError(errorText(error) || failure);
	}
}
