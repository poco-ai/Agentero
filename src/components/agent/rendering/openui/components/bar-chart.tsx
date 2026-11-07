/** biome-ignore-all lint/suspicious/noArrayIndexKey: bar order follows the model-provided series. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildBarChartGeometry } from "@/lib/agent/openui/chart";
import {
	numberList,
	optionalStringProp,
	stringList,
	stringProp,
} from "./shared";

export function BarChartNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const title = stringProp(node.props, "title");
	const labels = stringList(node.props.labels);
	const values = numberList(node.props.values);
	const unit = optionalStringProp(node.props, "unit");
	const geometry = buildBarChartGeometry(labels, values, unit);
	const { width, height, plot, bars, grid } = geometry;

	return (
		<Card size="sm" className="w-full gap-2 py-3">
			<CardHeader className="px-3 pb-0">
				<CardTitle className="text-sm">{title}</CardTitle>
			</CardHeader>
			<CardContent className="px-2 pb-2">
				{bars.length === 0 ? (
					<p className="px-1 text-sm text-muted-foreground">
						{t("uiBlock.chartEmpty")}
					</p>
				) : (
					<svg
						viewBox={`0 0 ${width} ${height}`}
						role="img"
						aria-label={t("uiBlock.chartAria", { title })}
						className="h-auto w-full"
					>
						{grid.map((line) => (
							<line
								key={`grid-${line.y}`}
								x1={plot.x}
								x2={plot.x + plot.width}
								y1={line.y}
								y2={line.y}
								className="stroke-border"
								strokeDasharray="3 4"
								strokeWidth={1}
							/>
						))}
						{bars.map((bar, index) => (
							<g key={`${bar.fullLabel}-${index}`}>
								<title>{`${bar.fullLabel}: ${bar.valueLabel}`}</title>
								<rect
									x={bar.x}
									y={bar.y}
									width={bar.width}
									height={Math.max(0, bar.height)}
									rx={3}
									className="fill-primary"
									opacity={0.72}
								/>
								<text
									x={bar.x + bar.width / 2}
									y={Math.max(plot.y + 10, bar.y - 6)}
									textAnchor="middle"
									className="fill-foreground text-[10px]"
								>
									{bar.valueLabel}
								</text>
								<text
									x={bar.x + bar.width / 2}
									y={plot.y + plot.height + 18}
									textAnchor="middle"
									className="fill-muted-foreground text-[10px]"
								>
									{bar.label}
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
					</svg>
				)}
			</CardContent>
		</Card>
	);
}
