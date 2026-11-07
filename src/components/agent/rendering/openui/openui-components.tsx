/** biome-ignore-all lint/suspicious/noArrayIndexKey: OpenUI nodes are read-only model output rendered in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { isElementNode } from "@openuidev/lang-core";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	type BarChartGeometry,
	buildBarChartGeometry,
} from "@/lib/agent/openui/chart";
import { cn } from "@/lib/core/utils";
import { OpenUiTable } from "./markdown-table";

type Props = Record<string, unknown>;

function stringProp(props: Props, key: string): string {
	const value = props[key];
	return typeof value === "string" ? value : "";
}

function optionalStringProp(props: Props, key: string): string | undefined {
	const value = props[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function stringMatrix(value: unknown): string[][] {
	if (!Array.isArray(value)) return [];
	return value.map((row) => stringList(row));
}

function numberList(value: unknown): number[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is number =>
					typeof item === "number" && Number.isFinite(item),
			)
		: [];
}

function childNodes(value: unknown): ElementNode[] {
	return Array.isArray(value) ? value.filter(isElementNode) : [];
}

function gapClass(value: unknown): string {
	switch (value) {
		case "sm":
			return "gap-2";
		case "lg":
			return "gap-5";
		default:
			return "gap-3";
	}
}

export function OpenUiNode({ node }: { node: ElementNode }) {
	return (
		<div
			className={cn("min-w-0", node.typeName === "Stat" && "flex-1")}
			data-openui-component={node.typeName}
		>
			{renderNode(node)}
		</div>
	);
}

function renderNode(node: ElementNode): ReactNode {
	switch (node.typeName) {
		case "Stack":
			return <StackNode node={node} />;
		case "Row":
			return <RowNode node={node} />;
		case "Text":
			return <TextNode node={node} />;
		case "Table":
			return <TableNode node={node} />;
		case "Stat":
			return <StatNode node={node} />;
		case "BarChart":
			return <BarChartNode node={node} />;
		case "Steps":
			return <StepsNode node={node} />;
		case "Callout":
			return <CalloutNode node={node} />;
		default:
			return null;
	}
}

function Children({ nodes }: { nodes: ElementNode[] }) {
	return (
		<>
			{nodes.map((child, index) => (
				<OpenUiNode
					key={`${child.statementId ?? child.typeName}-${index}`}
					node={child}
				/>
			))}
		</>
	);
}

function StackNode({ node }: { node: ElementNode }) {
	return (
		<div className={cn("flex min-w-0 flex-col", gapClass(node.props.gap))}>
			<Children nodes={childNodes(node.props.children)} />
		</div>
	);
}

function RowNode({ node }: { node: ElementNode }) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-wrap items-stretch",
				gapClass(node.props.gap),
			)}
		>
			<Children nodes={childNodes(node.props.children)} />
		</div>
	);
}

function TextNode({ node }: { node: ElementNode }) {
	const text = stringProp(node.props, "text");
	const variant = stringProp(node.props, "variant") || "body";
	if (variant === "code") {
		return (
			<pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm whitespace-pre-wrap">
				<code>{text}</code>
			</pre>
		);
	}
	if (variant === "heading") {
		return (
			<p className="font-heading text-base font-semibold whitespace-pre-wrap">
				{text}
			</p>
		);
	}
	if (variant === "caption") {
		return (
			<p className="text-xs text-muted-foreground whitespace-pre-wrap">
				{text}
			</p>
		);
	}
	return <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>;
}

function TableNode({ node }: { node: ElementNode }) {
	const columns = stringList(node.props.columns);
	const rows = stringMatrix(node.props.rows);
	return (
		<OpenUiTable
			columns={columns}
			rows={rows}
			caption={optionalStringProp(node.props, "caption")}
		/>
	);
}

function StatNode({ node }: { node: ElementNode }) {
	const hint = optionalStringProp(node.props, "hint");
	return (
		<Card size="sm" className="min-w-36 gap-1 py-3">
			<CardContent className="px-3">
				<div className="truncate text-xs text-muted-foreground">
					{stringProp(node.props, "label")}
				</div>
				<div className="mt-1 font-heading text-2xl font-semibold tracking-tight">
					{stringProp(node.props, "value")}
				</div>
				{hint ? (
					<div className="mt-1 truncate text-xs text-muted-foreground">
						{hint}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

function BarChartNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const title = stringProp(node.props, "title");
	const labels = stringList(node.props.labels);
	const values = numberList(node.props.values);
	const unit = optionalStringProp(node.props, "unit");
	const geometry = buildBarChartGeometry(labels, values, unit);

	return (
		<Card size="sm" className="w-full gap-2 py-3">
			<CardHeader className="px-3 pb-0">
				<CardTitle className="text-sm">{title}</CardTitle>
			</CardHeader>
			<CardContent className="px-2 pb-2">
				{geometry.bars.length === 0 ? (
					<p className="px-1 text-sm text-muted-foreground">
						{t("uiBlock.chartEmpty")}
					</p>
				) : (
					<BarChartSvg
						geometry={geometry}
						ariaLabel={t("uiBlock.chartAria", { title })}
					/>
				)}
			</CardContent>
		</Card>
	);
}

function BarChartSvg({
	geometry,
	ariaLabel,
}: {
	geometry: BarChartGeometry;
	ariaLabel: string;
}) {
	const { width, height, plot, bars, grid } = geometry;
	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			role="img"
			aria-label={ariaLabel}
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
	);
}

function StepsNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const steps = stringList(node.props.steps);
	return (
		<Card size="sm" className="w-full gap-2 py-3">
			<CardHeader className="px-3 pb-0">
				<CardTitle className="text-sm">
					{stringProp(node.props, "title")}
				</CardTitle>
			</CardHeader>
			<CardContent className="px-3">
				{steps.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t("uiBlock.stepsEmpty")}
					</p>
				) : (
					<ol className="space-y-2.5">
						{steps.map((step, index) => (
							<li key={`${index}-${step}`} className="flex gap-2.5">
								<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
									{index + 1}
								</span>
								<span className="min-w-0 text-sm leading-relaxed whitespace-pre-wrap">
									{step}
								</span>
							</li>
						))}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}

const CALLOUT_TONES: Record<
	string,
	{ icon: ComponentType<{ className?: string }>; className: string }
> = {
	info: { icon: Info, className: "border-border bg-muted/40" },
	success: {
		icon: CircleCheck,
		className: "border-emerald-500/30 bg-emerald-500/10",
	},
	warning: {
		icon: TriangleAlert,
		className: "border-amber-500/35 bg-amber-500/10",
	},
	danger: {
		icon: CircleX,
		className: "border-destructive/35 bg-destructive/10",
	},
};

function CalloutNode({ node }: { node: ElementNode }) {
	const tone = stringProp(node.props, "tone") || "info";
	const config = CALLOUT_TONES[tone] ?? CALLOUT_TONES.info;
	const Icon = config?.icon ?? Info;
	return (
		<div className={cn("rounded-lg border px-3 py-2.5", config?.className)}>
			<div className="flex items-center gap-2 text-sm font-medium">
				<Icon className="size-4 shrink-0" />
				<span className="min-w-0">{stringProp(node.props, "title")}</span>
			</div>
			<p className="mt-1.5 text-sm text-muted-foreground whitespace-pre-wrap">
				{stringProp(node.props, "body")}
			</p>
		</div>
	);
}
