"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MathText } from "@/components/ui/math-text";
import { cn } from "@/lib/core/utils";
import { useOpenUiSource } from "../source-context";
import { stringProp } from "./shared";

const STATUS_KEY = {
	unread: "uiBlock.paperStatus.unread",
	reading: "uiBlock.paperStatus.reading",
	read: "uiBlock.paperStatus.read",
	queued: "uiBlock.paperStatus.queued",
} as const;

const STATUS_CLASS = {
	unread: "border-border bg-muted text-muted-foreground",
	reading: "border-primary/30 bg-primary/10 text-primary",
	read: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	queued:
		"border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function PaperCardNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const onOpenSource = useOpenUiSource();
	const paper = isRecord(node.props.paper) ? node.props.paper : {};
	const status =
		typeof paper.status === "string" && paper.status in STATUS_KEY
			? (paper.status as keyof typeof STATUS_KEY)
			: undefined;
	const tags = Array.isArray(paper.tags)
		? paper.tags.filter((tag): tag is string => typeof tag === "string")
		: [];
	const meta = [stringProp(paper, "venue"), stringProp(paper, "year")]
		.filter(Boolean)
		.join(" · ");
	const path = stringProp(paper, "path");

	return (
		<Card size="sm" className="w-full gap-2 py-3">
			<CardHeader className="px-3 pb-0">
				<div className="flex min-w-0 items-start justify-between gap-2">
					<CardTitle className="min-w-0 text-sm leading-snug">
						<MathText text={stringProp(paper, "title")} />
					</CardTitle>
					{status ? (
						<Badge
							variant="outline"
							className={cn(
								"h-5 shrink-0 rounded-md px-1.5 text-[11px]",
								STATUS_CLASS[status],
							)}
						>
							{t(STATUS_KEY[status])}
						</Badge>
					) : null}
				</div>
				<div className="truncate text-xs text-muted-foreground">
					{stringProp(paper, "authors")}
				</div>
				{meta ? (
					<div className="truncate text-xs text-muted-foreground">{meta}</div>
				) : null}
			</CardHeader>
			<CardContent className="flex flex-wrap items-center gap-1.5 px-3">
				{tags.map((tag) => (
					<Badge
						key={tag}
						variant="outline"
						className="h-5 rounded-md px-1.5 text-[11px]"
					>
						{tag}
					</Badge>
				))}
				{path && onOpenSource ? (
					<button
						type="button"
						className="ms-auto text-xs text-primary underline underline-offset-2"
						onClick={() => onOpenSource(path)}
					>
						{t("uiBlock.openPaper")}
					</button>
				) : null}
			</CardContent>
		</Card>
	);
}
