"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { ImageIcon, ListOrdered, Sigma, Table2, TextQuote } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import { MarkdownText } from "../markdown-text";
import { BLOCK_TITLE_CLASS, NESTED_SURFACE_CLASS } from "../styles";
import { stringProp } from "./shared";
import { SourceReference } from "./source-reference";
import { ToneBadge } from "./tone-badge";

const KIND_KEY = {
	figure: "uiBlock.figureKind.figure",
	table: "uiBlock.figureKind.table",
	formula: "uiBlock.figureKind.formula",
	algorithm: "uiBlock.figureKind.algorithm",
	section: "uiBlock.figureKind.section",
} as const;

const KIND_ICON: Record<
	keyof typeof KIND_KEY,
	ComponentType<{ className?: string }>
> = {
	figure: ImageIcon,
	table: Table2,
	formula: Sigma,
	algorithm: ListOrdered,
	section: TextQuote,
};

function resolveKind(value: string): keyof typeof KIND_KEY {
	return (value in KIND_KEY ? value : "figure") as keyof typeof KIND_KEY;
}

export function FigureRefNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const kind = resolveKind(stringProp(node.props, "kind"));
	const Icon = KIND_ICON[kind];
	const source = stringProp(node.props, "source");
	const caption = stringProp(node.props, "caption");

	return (
		<div
			className={cn(
				NESTED_SURFACE_CLASS,
				"flex items-start gap-2.5 px-3 py-2.5",
			)}
		>
			<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground">
				<Icon className="size-3.5" aria-hidden />
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-start justify-between gap-2">
					<span className={cn(BLOCK_TITLE_CLASS, "min-w-0 break-words")}>
						{stringProp(node.props, "label")}
					</span>
					<ToneBadge tone="neutral">{t(KIND_KEY[kind])}</ToneBadge>
				</div>
				{caption ? (
					<MarkdownText
						text={caption}
						className="mt-1 text-xs text-muted-foreground"
					/>
				) : null}
				<SourceReference
					source={source}
					actionLabel={t("uiBlock.openSource")}
					className="mt-1.5"
				/>
			</div>
		</div>
	);
}
