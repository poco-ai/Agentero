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
	localDay,
	weekCells,
} from "@/lib/activity/board";
import { cn } from "@/lib/core/utils";

/**
 * Heatmap geometry: square cells that grow with the card so the six-month
 * window fills the pane instead of leaving a hole on the right.
 */
const CELL = "var(--heat-cell)";
const CELL_GAP = "var(--heat-gap)";
/** Month row height plus its bottom margin — offsets the weekday rail. */
const MONTH_ROW_HEIGHT = 22;

/** Cell size nowrap by container width; the legend follows the same scale. */
const HEAT_SCALE_CLASS =
	"[--heat-cell:13px] [--heat-gap:3px] @[520px]/heat:[--heat-cell:15px] @[660px]/heat:[--heat-cell:16px] @[820px]/heat:[--heat-cell:17px]";

const LEVEL_CLASS = [
	"bg-muted",
	"bg-primary/25",
	"bg-primary/45",
	"bg-primary/70",
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
	const weeks = Math.ceil(cells.length / 7);
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
		<div className="@container/heat overflow-x-auto pb-1">
			<div className={cn("flex w-max gap-2.5", HEAT_SCALE_CLASS)}>
				<div
					className="grid grid-rows-7 text-[10px] text-muted-foreground"
					style={{ paddingTop: MONTH_ROW_HEIGHT, gap: CELL_GAP }}
				>
					{([0, 1, 2, 3, 4, 5, 6] as const).map((row) => (
						<span key={row} style={{ lineHeight: CELL }}>
							{weekday(row)}
						</span>
					))}
				</div>
				<div>
					<div
						className="mb-1.5 grid h-4 text-[11px] text-muted-foreground"
						style={{
							gridTemplateColumns: `repeat(${weeks}, ${CELL})`,
							columnGap: CELL_GAP,
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
							gridTemplateRows: `repeat(7, ${CELL})`,
							gridAutoFlow: "column",
							gridAutoColumns: CELL,
							gap: CELL_GAP,
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
								<span key={cell.date} />
							) : (
								<Tooltip key={cell.date}>
									<TooltipTrigger asChild>
										<span
											role="img"
											className={cn("rounded-[3px]", LEVEL_CLASS[cell.level])}
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
			<div
				className={cn(
					"mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground",
					HEAT_SCALE_CLASS,
				)}
			>
				<span>{t("activity.heatmap.less")}</span>
				{LEVEL_CLASS.map((level) => (
					<span
						key={level}
						className={cn("rounded-[3px]", level)}
						style={{ width: CELL, height: CELL }}
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

function WeekBar({
	cell,
	todayKey,
	max,
}: {
	cell: HeatCell;
	todayKey: string;
	max: number;
}) {
	return (
		<div className="group flex h-full min-w-0 flex-1 items-end justify-center">
			<div
				className={cn(
					"w-full max-w-7 rounded-t-[3px] transition-colors",
					cell.date === todayKey
						? "bg-primary"
						: "bg-primary/55 group-hover:bg-primary/80",
				)}
				style={{
					height:
						cell.value > 0 ? Math.max(4, (cell.value / max) * 60) : undefined,
				}}
			/>
		</div>
	);
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
	const todayKey = localDay(today);
	const max = Math.max(...cells.map((cell) => cell.value), 1);
	const valueText = (cell: HeatCell) =>
		metric === "tokens"
			? formatTokenCount(cell.value)
			: durationText(t, cell.value);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex h-16 items-end gap-2 border-b border-border/50">
				{cells.map((cell, index) =>
					cell.future ? (
						<div key={cell.date} className="flex h-full min-w-0 flex-1" />
					) : (
						<Tooltip key={cell.date}>
							<TooltipTrigger asChild>
								<WeekBar cell={cell} todayKey={todayKey} max={max} />
							</TooltipTrigger>
							<TooltipContent>
								{`${weekdayLabel(t, (weekStartsOn + index) % 7)} · ${valueText(cell)}`}
							</TooltipContent>
						</Tooltip>
					),
				)}
			</div>
			<div className="flex gap-2">
				{cells.map((cell, index) => (
					<span
						key={cell.date}
						className={cn(
							"min-w-0 flex-1 text-center text-[10px]",
							cell.date === todayKey
								? "text-foreground"
								: "text-muted-foreground",
						)}
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
		<div className="flex flex-col gap-2.5">
			{board.workflows.map((row) => {
				const label = workflowLabel(t, row.workflow);
				return (
					<div
						key={row.workflow || "free"}
						className="grid grid-cols-[6.5rem_minmax(0,1fr)_1.75rem] items-center gap-2"
					>
						<span className="truncate text-xs">{label}</span>
						<div className="h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary/80"
								style={{
									width: `${Math.max(4, (row.count / max) * 100)}%`,
								}}
							/>
						</div>
						<span className="text-right text-[11px] text-muted-foreground tabular-nums">
							{row.count}
						</span>
					</div>
				);
			})}
		</div>
	);
}
