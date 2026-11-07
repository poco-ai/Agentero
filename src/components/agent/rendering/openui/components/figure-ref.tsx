"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { ImageIcon, ListOrdered, Sigma, Table2, TextQuote } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { MarkdownText } from "../markdown-text";
import { useOpenUiSource } from "../source-context";
import { stringProp } from "./shared";

const KIND_KEY = {
	figure: "uiBlock.figureKind.figure",
	table: "uiBlock.figureKind.table",
	equation: "uiBlock.figureKind.equation",
	algorithm: "uiBlock.figureKind.algorithm",
	section: "uiBlock.figureKind.section",
} as const;

const KIND_ICON: Record<
	keyof typeof KIND_KEY,
	ComponentType<{ className?: string }>
> = {
	figure: ImageIcon,
	table: Table2,
	equation: Sigma,
	algorithm: ListOrdered,
	section: TextQuote,
};

export function FigureRefNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const onOpenSource = useOpenUiSource();
	const kind =
		stringProp(node.props, "kind") in KIND_KEY
			? (stringProp(node.props, "kind") as keyof typeof KIND_KEY)
			: "figure";
	const Icon = KIND_ICON[kind];
	const source = stringProp(node.props, "source");

	return (
		<div className="rounded-lg border bg-muted/20 px-3 py-2.5">
			<div className="flex min-w-0 items-center gap-2 text-sm font-medium">
				<Icon className="size-4 shrink-0 text-muted-foreground" />
				<span className="min-w-0">{stringProp(node.props, "label")}</span>
				<Badge
					variant="outline"
					className="h-5 shrink-0 rounded-md px-1.5 text-[11px] text-muted-foreground"
				>
					{t(KIND_KEY[kind])}
				</Badge>
			</div>
			{stringProp(node.props, "caption") ? (
				<MarkdownText
					text={stringProp(node.props, "caption")}
					className="mt-1 text-xs text-muted-foreground"
				/>
			) : null}
			{source && onOpenSource ? (
				<button
					type="button"
					className="mt-1.5 text-xs text-primary underline underline-offset-2"
					onClick={() => onOpenSource(source)}
				>
					{t("uiBlock.openSource")}
				</button>
			) : null}
		</div>
	);
}
