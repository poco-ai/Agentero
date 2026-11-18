import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { UsageBoard, UsageDayStat } from "@/lib/activity/api";
import {
	type ActivityMetric,
	formatDuration,
	formatTokenCount,
	type HeatCell,
	heatCells,
	weekCells,
} from "@/lib/activity/board";
import { cn } from "@/lib/core/utils";

const LEVEL_CLASS = [
	"bg-muted",
	"bg-primary/30",
	"bg-primary/50",
	"bg-primary/75",
	"bg-primary",
] as const;

/** A month label needs about three week columns, or "11月" collapses to "1…". */
const MONTH_MIN_WEEKS = 3;

function monthMarks(
	cells: HeatCell[],
	format: (date: Date) => string,
): { key: string; label: string; start: number; span: number }[] {
	const weeks = Math.ceil(cells.length / 7);
	const starts: { week: number; label: string; key: string }[] = [];
	for (let week = 0; week < weeks; week += 1) {
		const column = cells.slice(week * 7, week * 7 + 7);
		const firstOfMonth = column.find((item) => item.date.endsWith("-01"));
		const anchor = firstOfMonth ?? (week === 0 ? column[0] : undefined);
		if (!anchor) continue;
		const label = format(new Date(`${anchor.date}T00:00:00`));
		if (starts[starts.length - 1]?.label === label) continue;
		starts.push({ week, label, key: anchor.date });
	}
	const visible = starts.filter((item, index) => {
		const nextWeek = starts[index + 1]?.week ?? weeks;
		return nextWeek - item.week >= MONTH_MIN_WEEKS;
	});
	return visible.map((item, index) => {
		const nextWeek = visible[index + 1]?.week ?? weeks;
		return {
			key: item.key,
			label: item.label,
			start: item.week + 1,
			span: nextWeek - item.week,
		};
	});
}

function cellText(
	cell: HeatCell,
	metric: ActivityMetric,
	format: (ms: number) => string,
): string {
	if (metric === "tokens") return formatTokenCount(cell.value);
	return format(cell.value);
}

export function ActivityHeatmap({
	days,
	today,
	weekStartsOn,
	metric,
}: {
	days: UsageDayStat[];
	today: Date;
	weekStartsOn: 0 | 1;
	metric: ActivityMetric;
}) {
	const { t, i18n } = useTranslation("settings");
	const cells = heatCells(days, today, weekStartsOn, metric);
	const months = new Intl.DateTimeFormat(i18n.language, { month: "short" });
	const marks = monthMarks(cells, (date) => months.format(date));
	const formatReading = (ms: number) => durationText(t, ms);
	const weekday = (index: number) => {
		const day = (weekStartsOn + index) % 7;
		if (day === 1) return t("activity.weekday.mon");
		if (day === 3) return t("activity.weekday.wed");
		if (day === 5) return t("activity.weekday.fri");
		return "";
	};

	return (
		<div className="overflow-x-auto pb-1">
			<div className="flex w-max gap-2">
				<div className="grid grid-rows-7 gap-[3px] pt-5 text-[10px] text-muted-foreground leading-[11px]">
					{([0, 1, 2, 3, 4, 5, 6] as const).map((row) => (
						<span key={row} className="h-[11px]">
							{weekday(row)}
						</span>
					))}
				</div>
				<div>
					<div
						className="mb-1 grid h-4 text-muted-foreground text-xs"
						style={{
							gridTemplateColumns: "repeat(53, 11px)",
							columnGap: "3px",
						}}
					>
						{marks.map((mark) => (
							<span
								key={mark.key}
								className="overflow-hidden whitespace-nowrap"
								style={{ gridColumn: `${mark.start} / span ${mark.span}` }}
							>
								{mark.label}
							</span>
						))}
					</div>
					<div
						className="grid"
						style={{
							gridTemplateRows: "repeat(7, 11px)",
							gridAutoFlow: "column",
							gridAutoColumns: "11px",
							gap: "3px",
						}}
						role="img"
						aria-label={t(
							metric === "reading"
								? "activity.heatmap.reading"
								: "activity.heatmap.tokens",
						)}
					>
						{cells.map((cell) =>
							cell.future ? (
								<span key={cell.date} className="size-[11px]" />
							) : (
								<Tooltip key={cell.date}>
									<TooltipTrigger asChild>
										<span
											role="img"
											className={cn(
												"size-[11px] rounded-[2px]",
												LEVEL_CLASS[cell.level],
											)}
											aria-label={t("activity.heatmap.cell", {
												date: cell.date,
												value: cellText(cell, metric, formatReading),
											})}
										/>
									</TooltipTrigger>
									<TooltipContent>
										{t("activity.heatmap.cell", {
											date: cell.date,
											value: cellText(cell, metric, formatReading),
										})}
									</TooltipContent>
								</Tooltip>
							),
						)}
					</div>
				</div>
			</div>
			<div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
				<span>{t("activity.heatmap.less")}</span>
				{LEVEL_CLASS.map((level) => (
					<span
						key={level}
						className={cn("size-[11px] rounded-[2px]", level)}
					/>
				))}
				<span>{t("activity.heatmap.more")}</span>
			</div>
		</div>
	);
}

function weekdayLabel(t: TFunction<"settings">, day: number): string {
	switch (day) {
		case 0:
			return t("activity.weekday.sun");
		case 1:
			return t("activity.weekday.mon");
		case 2:
			return t("activity.weekday.tue");
		case 3:
			return t("activity.weekday.wed");
		case 4:
			return t("activity.weekday.thu");
		case 5:
			return t("activity.weekday.fri");
		default:
			return t("activity.weekday.sat");
	}
}

export function ActivityWeekBars({
	days,
	today,
	weekStartsOn,
	metric,
}: {
	days: UsageDayStat[];
	today: Date;
	weekStartsOn: 0 | 1;
	metric: ActivityMetric;
}) {
	const { t } = useTranslation("settings");
	const cells = weekCells(days, today, weekStartsOn, metric);
	const max = Math.max(...cells.map((cell) => cell.value), 1);
	return (
		<div className="flex flex-col gap-1">
			<div className="flex h-12 items-end gap-2 border-b border-border/70">
				{cells.map((cell) => {
					const height =
						cell.value <= 0 ? 0 : Math.max(4, (cell.value / max) * 48);
					return (
						<div
							key={cell.date}
							className="flex h-full min-w-0 flex-1 items-end justify-center"
						>
							{cell.value > 0 ? (
								<div
									className="w-full max-w-6 rounded-t-sm bg-primary/80"
									style={{ height }}
								/>
							) : null}
						</div>
					);
				})}
			</div>
			<div className="flex gap-2">
				{cells.map((cell, index) => (
					<span
						key={cell.date}
						className="min-w-0 flex-1 text-center text-[10px] text-muted-foreground"
					>
						{weekdayLabel(t, (weekStartsOn + index) % 7)}
					</span>
				))}
			</div>
		</div>
	);
}

function workflowLabel(t: TFunction<"settings">, workflow: string): string {
	switch (workflow) {
		case "qa":
			return t("activity.workflow.qa");
		case "summary":
			return t("activity.workflow.summary");
		case "related_work":
			return t("activity.workflow.related_work");
		case "paper_reader":
			return t("activity.workflow.paper_reader");
		case "translate":
			return t("activity.workflow.translate");
		case "":
		case "free":
			return t("activity.workflow.free");
		default:
			return workflow;
	}
}

export function durationText(t: TFunction<"settings">, ms: number): string {
	const { hours, minutes } = formatDuration(ms);
	if (hours <= 0) {
		return t("activity.duration.minutes", { count: minutes });
	}
	if (minutes === 0) {
		return t("activity.duration.hours", { count: hours });
	}
	return t("activity.duration.hoursMinutes", { hours, minutes });
}

export function ActivityWorkflows({ board }: { board: UsageBoard }) {
	const { t } = useTranslation("settings");
	if (board.workflows.length === 0) return null;
	const max = Math.max(...board.workflows.map((row) => row.count), 1);
	return (
		<div className="flex flex-col gap-2">
			{board.workflows.map((row) => {
				const label = workflowLabel(t, row.workflow);
				return (
					<div
						key={row.workflow || "free"}
						className="grid grid-cols-[7.5rem_minmax(0,1fr)_2rem] items-center gap-2"
					>
						<span className="truncate text-sm">{label}</span>
						<div className="h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary"
								style={{ width: `${Math.max(4, (row.count / max) * 100)}%` }}
							/>
						</div>
						<span className="text-right text-xs tabular-nums text-muted-foreground">
							{row.count}
						</span>
					</div>
				);
			})}
		</div>
	);
}
