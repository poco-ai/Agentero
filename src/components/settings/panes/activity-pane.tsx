import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ActivityHeatmap,
	ActivityWeekBars,
	ActivityWorkflows,
	durationText,
} from "@/components/settings/activity/activity-charts";
import { PageTitle } from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
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

	return (
		<div className="flex flex-col gap-5">
			<PageTitle title={t("activity.title")} />
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				<Stat
					label={t("activity.week.reading")}
					value={durationText(t, reading)}
					delta={reading - previousReading}
					deltaText={durationText(t, Math.abs(reading - previousReading))}
				/>
				<Stat
					label={t("activity.week.papers")}
					value={String(board.weekPaperCount)}
				/>
				<Stat
					label={t("activity.week.agent")}
					value={String(runs)}
					delta={runs - previousRuns}
					deltaText={String(Math.abs(runs - previousRuns))}
				/>
				<Stat
					label={t("activity.week.tokens")}
					value={
						reported ? formatTokenCount(tokens) : t("activity.week.unreported")
					}
					delta={reported ? tokens - previousTokens : undefined}
					deltaText={formatTokenCount(Math.abs(tokens - previousTokens))}
				/>
			</div>
			<section className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2">
					<h3 className="font-medium text-sm">
						{t(
							metric === "reading"
								? "activity.heatmap.reading"
								: "activity.heatmap.tokens",
						)}
					</h3>
					<div className="flex gap-1">
						<Button
							type="button"
							size="sm"
							variant={metric === "reading" ? "secondary" : "ghost"}
							onClick={() => setMetric("reading")}
						>
							{t("activity.metric.reading")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant={metric === "tokens" ? "secondary" : "ghost"}
							onClick={() => setMetric("tokens")}
						>
							{t("activity.metric.tokens")}
						</Button>
					</div>
				</div>
				<ActivityHeatmap
					days={board.days}
					today={today}
					weekStartsOn={weekStartsOn}
					metric={metric}
				/>
			</section>
			<section className="flex flex-col gap-2">
				<h3 className="font-medium text-sm">{t("activity.thisWeek")}</h3>
				<ActivityWeekBars
					days={board.days}
					today={today}
					weekStartsOn={weekStartsOn}
					metric={metric}
				/>
			</section>
			{board.workflows.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">{t("activity.workflows")}</h3>
					<ActivityWorkflows board={board} />
				</section>
			)}
			{board.papers.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">{t("activity.papers")}</h3>
					<ol className="flex flex-col gap-1.5">
						{board.papers.map((paper) => (
							<li
								key={paper.path}
								className="flex items-baseline justify-between gap-3 text-sm"
							>
								<button
									type="button"
									className="min-w-0 truncate text-left hover:underline"
									onClick={() => {
										if (!vaultPath) return;
										void openActivityPaper(
											vaultPath,
											paper.path,
											t("activity.openFailed"),
										);
									}}
								>
									{paperLabel(paper.path, paper.title)}
								</button>
								<span className="shrink-0 tabular-nums text-muted-foreground">
									{durationText(t, paper.readingMs)}
								</span>
							</li>
						))}
					</ol>
				</section>
			)}
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

function Stat({
	label,
	value,
	delta,
	deltaText,
}: {
	label: string;
	value: string;
	delta?: number;
	deltaText?: string;
}) {
	const signed =
		delta == null || delta === 0 || !deltaText
			? null
			: `${delta > 0 ? "+" : "−"}${deltaText}`;
	return (
		<div className="rounded-xl border border-border/70 px-3 py-2.5">
			<div className="flex items-start justify-between gap-2">
				<p className="text-muted-foreground text-xs">{label}</p>
				{signed ? (
					<p
						className={cn(
							"shrink-0 text-xs tabular-nums",
							delta != null && delta > 0 ? "text-destructive" : "text-success",
						)}
					>
						{signed}
					</p>
				) : null}
			</div>
			<p className="mt-1 font-medium text-base tabular-nums">{value}</p>
		</div>
	);
}
