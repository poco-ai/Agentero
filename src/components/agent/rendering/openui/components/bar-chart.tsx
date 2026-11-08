/** biome-ignore-all lint/suspicious/noArrayIndexKey: bar order follows the model-provided series. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { buildBarChartGeometry } from "@/lib/agent/openui/chart";
import { ChartFrame, ChartGrid } from "./chart-frame";
import {
	numberList,
	optionalStringProp,
	stringList,
	stringProp,
} from "./shared";
import { useChartWidth } from "./use-chart-width";

export function BarChartNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const title = stringProp(node.props, "title");
	const labels = stringList(node.props.labels);
	const values = numberList(node.props.values);
	const unit = optionalStringProp(node.props, "unit");
	const { ref: chartRef, width: chartWidth } = useChartWidth();
	const geometry = buildBarChartGeometry(labels, values, unit, chartWidth);
	const { width, height, plot, bars, grid, labelStep } = geometry;
	const slot = bars.length > 0 ? plot.width / bars.length : 0;
	// Give every bar a title, but keep values off the chart when bars get thin.
	const showAxisLabel = (index: number) => index % labelStep === 0;
	const showValueLabel = slot >= 26;

	return (
		<ChartFrame
			title={title}
			ariaLabel={t("uiBlock.chartAria", { title })}
			emptyLabel={t("uiBlock.chartEmpty")}
			hasData={bars.length > 0}
			chartRef={chartRef}
			width={width}
			height={height}
		>
			<ChartGrid plot={plot} grid={grid} unit={unit} />
			{bars.map((bar, index) => (
				<g key={`${bar.fullLabel}-${index}`}>
					<title>{`${bar.fullLabel}: ${bar.valueLabel}`}</title>
					<rect
						x={bar.x}
						y={bar.y}
						width={bar.width}
						height={Math.max(0, bar.height)}
						rx={4}
						className="fill-primary"
						opacity={0.85}
					/>
					{showValueLabel ? (
						<text
							x={bar.x + bar.width / 2}
							y={bar.y - 6}
							textAnchor="middle"
							className="fill-foreground text-[10px] tabular-nums"
						>
							{bar.valueLabel}
						</text>
					) : null}
					{showAxisLabel(index) ? (
						<text
							x={bar.x + bar.width / 2}
							y={plot.y + plot.height + 18}
							textAnchor="middle"
							className="fill-muted-foreground text-[10px]"
						>
							{bar.label}
						</text>
					) : null}
				</g>
			))}
		</ChartFrame>
	);
}
