"use client";

import type { ReactNode, RefObject } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	type BarChartGeometry,
	formatChartValue,
} from "@/lib/agent/openui/chart";

type ChartPlot = BarChartGeometry["plot"];
type ChartGridLine = BarChartGeometry["grid"][number];

/** Shared card, SVG viewport and empty state for Bar / Line charts. */
export function ChartFrame({
	title,
	ariaLabel,
	emptyLabel,
	hasData,
	chartRef,
	width,
	height,
	children,
}: {
	title: string;
	ariaLabel: string;
	emptyLabel: string;
	hasData: boolean;
	chartRef: RefObject<HTMLDivElement | null>;
	width: number;
	height: number;
	children: ReactNode;
}) {
	return (
		<Card size="sm" className="w-full gap-2">
			{title ? (
				<CardHeader>
					<CardTitle className="break-words">{title}</CardTitle>
				</CardHeader>
			) : null}
			<CardContent className="px-2 pb-2">
				<div ref={chartRef} className="min-w-0">
					{hasData ? (
						<svg
							viewBox={`0 0 ${width} ${height}`}
							role="img"
							aria-label={ariaLabel}
							className="h-auto w-full"
						>
							{children}
						</svg>
					) : (
						<p className="px-1 text-sm text-muted-foreground">{emptyLabel}</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

/** Grid lines, y-axis ticks and the baseline; render before the data layer. */
export function ChartGrid({
	plot,
	grid,
	unit,
}: {
	plot: ChartPlot;
	grid: ChartGridLine[];
	unit?: string;
}) {
	return (
		<>
			{grid.map((line) => (
				<g key={`grid-${line.y}`}>
					{line.value > 0 ? (
						<line
							x1={plot.x}
							x2={plot.x + plot.width}
							y1={line.y}
							y2={line.y}
							className="stroke-border/70"
							strokeDasharray="3 4"
							strokeWidth={1}
						/>
					) : null}
					<text
						x={plot.x - 8}
						y={line.y + 3}
						textAnchor="end"
						className="fill-muted-foreground text-[10px] tabular-nums"
					>
						{formatChartValue(line.value, unit)}
					</text>
				</g>
			))}
			<line
				x1={plot.x}
				x2={plot.x + plot.width}
				y1={plot.y + plot.height}
				y2={plot.y + plot.height}
				className="stroke-border"
				strokeWidth={1}
			/>
		</>
	);
}
