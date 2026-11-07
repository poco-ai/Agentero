"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildLineChartGeometry } from "@/lib/agent/openui/chart";
import {
	numberList,
	optionalStringProp,
	stringList,
	stringProp,
} from "./shared";

export function LineChartNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const title = stringProp(node.props, "title");
	const labels = stringList(node.props.labels);
	const values = numberList(node.props.values);
	const unit = optionalStringProp(node.props, "unit");
	const geometry = buildLineChartGeometry(labels, values, unit);
	const { width, height, plot, points, path, areaPath, grid } = geometry;

	return (
		<Card size="sm" className="w-full gap-2 py-3">
			<CardHeader className="px-3 pb-0">
				<CardTitle className="text-sm">{title}</CardTitle>
			</CardHeader>
			<CardContent className="px-2 pb-2">
				{points.length === 0 ? (
					<p className="px-1 text-sm text-muted-foreground">
						{t("uiBlock.chartEmpty")}
					</p>
				) : (
					<svg
						viewBox={`0 0 ${width} ${height}`}
						role="img"
						aria-label={t("uiBlock.lineChartAria", { title })}
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
						{areaPath ? (
							<path d={areaPath} className="fill-primary" opacity={0.12} />
						) : null}
						<path
							d={path}
							fill="none"
							className="stroke-primary"
							strokeWidth={2}
							vectorEffect="non-scaling-stroke"
						/>
						{points.map((point) => (
							<g key={`${point.fullLabel}-${point.x}`}>
								<title>{`${point.fullLabel}: ${point.valueLabel}`}</title>
								<circle
									cx={point.x}
									cy={point.y}
									r={3}
									className="fill-background stroke-primary"
									strokeWidth={2}
								/>
								<text
									x={point.x}
									y={plot.y + plot.height + 18}
									textAnchor="middle"
									className="fill-muted-foreground text-[10px]"
								>
									{point.label}
								</text>
							</g>
						))}
					</svg>
				)}
			</CardContent>
		</Card>
	);
}
