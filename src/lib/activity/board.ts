import type { UsageBoard, UsageDayStat } from "@/lib/activity/api";

export type ActivityMetric = "reading" | "tokens";
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export type HeatCell = {
	date: string;
	value: number;
	level: HeatLevel;
	future: boolean;
};

export type BoardRange = {
	startDay: string;
	endDay: string;
	weekStart: string;
	prevStart: string;
	prevEnd: string;
};

const WEEKS = 53;

export function localDay(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
	const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	next.setDate(next.getDate() + days);
	return next;
}

/** `weekStartsOn`: 0 Sunday, 1 Monday. */
export function startOfWeek(date: Date, weekStartsOn: 0 | 1): Date {
	const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const shift = (day.getDay() - weekStartsOn + 7) % 7;
	return addDays(day, -shift);
}

export function boardQueryRange(today: Date, weekStartsOn: 0 | 1): BoardRange {
	const weekStart = startOfWeek(today, weekStartsOn);
	const start = addDays(weekStart, -(WEEKS - 1) * 7);
	return {
		startDay: localDay(start),
		endDay: localDay(today),
		weekStart: localDay(weekStart),
		prevStart: localDay(addDays(weekStart, -7)),
		prevEnd: localDay(addDays(weekStart, -1)),
	};
}

export function readingLevel(ms: number): HeatLevel {
	const minutes = ms / 60_000;
	if (minutes <= 0) return 0;
	if (minutes < 15) return 1;
	if (minutes < 45) return 2;
	if (minutes < 90) return 3;
	return 4;
}

export function tokenLevel(tokens: number): HeatLevel {
	if (tokens <= 0) return 0;
	if (tokens < 1_000) return 1;
	if (tokens < 10_000) return 2;
	if (tokens < 100_000) return 3;
	return 4;
}

export function sumDays(
	days: UsageDayStat[],
	from: string,
	to: string,
	pick: (day: UsageDayStat) => number,
): number {
	let total = 0;
	for (const day of days) {
		if (day.day >= from && day.day <= to) total += pick(day);
	}
	return total;
}

export function boardIsEmpty(board: UsageBoard): boolean {
	return (
		board.weekPaperCount === 0 &&
		board.workflows.length === 0 &&
		board.days.every(
			(day) => day.readingMs === 0 && day.agentRuns === 0 && day.tokens === 0,
		)
	);
}

export function tokensReported(board: UsageBoard): boolean {
	return board.days.some((day) => day.tokens > 0);
}

export function heatCells(
	days: UsageDayStat[],
	today: Date,
	weekStartsOn: 0 | 1,
	metric: ActivityMetric,
): HeatCell[] {
	const todayKey = localDay(today);
	const byDay = new Map(days.map((day) => [day.day, day]));
	const start = addDays(startOfWeek(today, weekStartsOn), -(WEEKS - 1) * 7);
	const cells: HeatCell[] = [];
	for (let index = 0; index < WEEKS * 7; index += 1) {
		const date = localDay(addDays(start, index));
		const stat = byDay.get(date);
		const value =
			metric === "reading" ? (stat?.readingMs ?? 0) : (stat?.tokens ?? 0);
		const future = date > todayKey;
		cells.push({
			date,
			value: future ? 0 : value,
			level: future
				? 0
				: metric === "reading"
					? readingLevel(value)
					: tokenLevel(value),
			future,
		});
	}
	return cells;
}

export function weekCells(
	days: UsageDayStat[],
	today: Date,
	weekStartsOn: 0 | 1,
	metric: ActivityMetric,
): HeatCell[] {
	const todayKey = localDay(today);
	const start = startOfWeek(today, weekStartsOn);
	const byDay = new Map(days.map((day) => [day.day, day]));
	return Array.from({ length: 7 }, (_, index) => {
		const date = localDay(addDays(start, index));
		const stat = byDay.get(date);
		const value =
			metric === "reading" ? (stat?.readingMs ?? 0) : (stat?.tokens ?? 0);
		const future = date > todayKey;
		return {
			date,
			value: future ? 0 : value,
			level: 0,
			future,
		};
	});
}

export function formatDuration(ms: number): {
	hours: number;
	minutes: number;
} {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

export function formatTokenCount(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) {
		const value = tokens / 1000;
		const digits = value >= 10 ? 0 : 1;
		return `${value.toFixed(digits)}k`;
	}
	const value = tokens / 1_000_000;
	const digits = value >= 10 ? 0 : 1;
	return `${value.toFixed(digits)}M`;
}

export function paperLabel(path: string, title?: string | null): string {
	const trimmed = title?.trim();
	if (trimmed) return trimmed;
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? path;
}
