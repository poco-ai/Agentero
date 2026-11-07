/**
 * Geometry for the built-in read-only bar chart. Kept pure so layout and label
 * truncation can be unit-tested without a DOM or a charting dependency.
 */

export const BAR_CHART_WIDTH = 640;
export const BAR_CHART_HEIGHT = 220;

const PADDING = { top: 28, right: 16, bottom: 46, left: 28 } as const;
const MAX_BAR_WIDTH = 48;
const BAR_SLOT_RATIO = 0.62;
const MAX_LABEL_CHARS = 14;

export type BarChartBar = {
	label: string;
	fullLabel: string;
	value: number;
	valueLabel: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type BarChartGeometry = {
	width: number;
	height: number;
	plot: { x: number; y: number; width: number; height: number };
	bars: BarChartBar[];
	grid: Array<{ y: number; value: number }>;
};

export function truncateChartLabel(label: string): string {
	const chars = [...label.trim()];
	if (chars.length <= MAX_LABEL_CHARS) return chars.join("");
	return `${chars.slice(0, MAX_LABEL_CHARS - 1).join("")}…`;
}

export function formatChartValue(value: number, unit?: string): string {
	const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
	return unit ? `${formatted}${unit}` : formatted;
}

export function buildBarChartGeometry(
	labels: readonly string[],
	values: readonly number[],
	unit?: string,
): BarChartGeometry {
	if (labels.length === 0) {
		return {
			width: BAR_CHART_WIDTH,
			height: BAR_CHART_HEIGHT,
			plot: { x: PADDING.left, y: PADDING.top, width: 0, height: 0 },
			bars: [],
			grid: [],
		};
	}

	const plot = {
		x: PADDING.left,
		y: PADDING.top,
		width: BAR_CHART_WIDTH - PADDING.left - PADDING.right,
		height: BAR_CHART_HEIGHT - PADDING.top - PADDING.bottom,
	};
	const maxValue = Math.max(1, ...values.filter(Number.isFinite));
	const slot = plot.width / labels.length;
	const barWidth = Math.min(MAX_BAR_WIDTH, slot * BAR_SLOT_RATIO);

	const bars = labels.map((label, index) => {
		const value = Math.max(0, values[index] ?? 0);
		const height = (value / maxValue) * plot.height;
		return {
			label: truncateChartLabel(label),
			fullLabel: label,
			value,
			valueLabel: formatChartValue(value, unit),
			x: plot.x + slot * index + (slot - barWidth) / 2,
			y: plot.y + plot.height - height,
			width: barWidth,
			height,
		};
	});

	return {
		width: BAR_CHART_WIDTH,
		height: BAR_CHART_HEIGHT,
		plot,
		bars,
		grid: [0, 0.5, 1].map((ratio) => ({
			y: plot.y + plot.height * (1 - ratio),
			value: maxValue * ratio,
		})),
	};
}
