"use client";

import type { ElementNode } from "@openuidev/lang-core";
import type { ComponentType } from "react";
import type { OpenUiComponentName } from "@/lib/agent/openui/generated/catalog";
import { cn } from "@/lib/core/utils";
import { BadgeNode } from "./components/badge";
import { BarChartNode } from "./components/bar-chart";
import { CalloutNode } from "./components/callout";
import { CardNode } from "./components/card";
import { CodeNode } from "./components/code";
import { DividerNode } from "./components/divider";
import { KeyValueNode } from "./components/key-value";
import { LineChartNode } from "./components/line-chart";
import { ListNode } from "./components/list";
import { MathNode } from "./components/math";
import { ProgressNode } from "./components/progress";
import { QuoteNode } from "./components/quote";
import { RowNode } from "./components/row";
import { SourceListNode } from "./components/source-list";
import { StackNode } from "./components/stack";
import { StatNode } from "./components/stat";
import { StepsNode } from "./components/steps";
import { TableNode } from "./components/table";
import { TagListNode } from "./components/tag-list";
import { TextNode } from "./components/text";
import { TimelineNode } from "./components/timeline";
import { TreeNode } from "./components/tree";
import { OpenUiNodeProvider } from "./node-context";

type NodeComponent = ComponentType<{ node: ElementNode }>;

const OPENUI_COMPONENT_REGISTRY = {
	Stack: StackNode,
	Row: RowNode,
	Card: CardNode,
	Text: TextNode,
	Badge: BadgeNode,
	Callout: CalloutNode,
	KeyValue: KeyValueNode,
	Table: TableNode,
	Stat: StatNode,
	Progress: ProgressNode,
	Steps: StepsNode,
	BarChart: BarChartNode,
	LineChart: LineChartNode,
	Quote: QuoteNode,
	Code: CodeNode,
	Math: MathNode,
	Divider: DividerNode,
	List: ListNode,
	Timeline: TimelineNode,
	Tree: TreeNode,
	TagList: TagListNode,
	SourceList: SourceListNode,
} satisfies Record<OpenUiComponentName, NodeComponent>;

export function OpenUiNode({ node }: { node: ElementNode }) {
	const Component =
		OPENUI_COMPONENT_REGISTRY[node.typeName as OpenUiComponentName];
	if (!Component) return null;
	return (
		<OpenUiNodeProvider render={(child) => <OpenUiNode node={child} />}>
			<div
				className={cn("min-w-0", node.typeName === "Stat" && "flex-1")}
				data-openui-component={node.typeName}
			>
				<Component node={node} />
			</div>
		</OpenUiNodeProvider>
	);
}
