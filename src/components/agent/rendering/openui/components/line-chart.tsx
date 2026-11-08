"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { buildLineChartGeometry } from "@/lib/agent/openui/chart";
import { ChartFrame, ChartGrid } from "./chart-frame";
import {
	numberList,
	optionalStringProp,
	stringList,
	stringProp,
} from "./shared";
import { useChartWidth } from "./use-chart-width";

export function LineChartNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const title = stringProp(node.props, "title");
	const labels = stringList(node.props.labels);
	const values = numberList(node.props.values);
	const unit = optionalStringProp(node.props, "unit");
	const { ref: chartRef, width: chartWidth } = useChartWidth();
	const geometry = buildLineChartGeometry(labels, values, unit, chartWidth);
	const { width, height, plot, points, path, areaPath, grid, labelStep } =
		geometry;
	const spacing =
		points.length > 1 ? plot.width / (points.length - 1) : plot.width;
	const showAxisLabel = (index: number) => index % labelStep === 0;
	const showValueLabels = spacing >= 64;

	return (
		<ChartFrame
			title={title}
			ariaLabel={t("uiBlock.lineChartAria", { title })}
			emptyLabel={t("uiBlock.chartEmpty")}
			hasData={points.length > 0}
			chartRef={chartRef}
			width={width}
			height={height}
		>
			<ChartGrid plot={plot} grid={grid} unit={unit} />
			{areaPath ? (
				<path d={areaPath} className="fill-primary" opacity={0.1} />
			) : null}
			<path
				d={path}
				fill="none"
				className="stroke-primary"
				strokeWidth={2}
				vectorEffect="non-scaling-stroke"
			/>
			{points.map((point, index) => (
				<g key={`${point.fullLabel}-${point.x}`}>
					<title>{`${point.fullLabel}: ${point.valueLabel}`}</title>
					<circle
						cx={point.x}
						cy={point.y}
						r={3}
						className="fill-background stroke-primary"
						strokeWidth={2}
					/>
					{showValueLabels ? (
						<text
							x={point.x}
							y={point.y - 8}
							textAnchor="middle"
							className="fill-foreground text-[10px] tabular-nums"
						>
							{point.valueLabel}
						</text>
					) : null}
					{showAxisLabel(index) ? (
						<text
							x={point.x}
							y={plot.y + plot.height + 18}
							textAnchor="middle"
							className="fill-muted-foreground text-[10px]"
						>
							{point.label}
						</text>
					) : null}
				</g>
			))}
		</ChartFrame>
	);
}
