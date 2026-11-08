"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MathText } from "@/components/ui/math-text";
import { isOpenUiSourceTarget } from "@/lib/agent/openui/source";
import { cn } from "@/lib/core/utils";
import { useOpenUiSource } from "../source-context";
import { BLOCK_CAPTION_CLASS, type OpenUiTone } from "../styles";
import { stringProp } from "./shared";
import { SourceReference } from "./source-reference";
import { TagBadge, ToneBadge } from "./tone-badge";

const STATUS_KEY = {
	unread: "uiBlock.paperStatus.unread",
	reading: "uiBlock.paperStatus.reading",
	read: "uiBlock.paperStatus.read",
	queued: "uiBlock.paperStatus.queued",
} as const;

const STATUS_TONE: Record<keyof typeof STATUS_KEY, OpenUiTone> = {
	unread: "neutral",
	reading: "info",
	read: "success",
	queued: "warning",
};

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
	const authors = stringProp(paper, "authors");
	const meta = [stringProp(paper, "venue"), stringProp(paper, "year")]
		.filter(Boolean)
		.join(" · ");
	const path = stringProp(paper, "path");
	const canOpenPath =
		Boolean(path) && Boolean(onOpenSource) && isOpenUiSourceTarget(path);

	return (
		<Card size="sm" className="w-full gap-2">
			<CardHeader>
				<div className="flex min-w-0 items-start justify-between gap-2">
					<CardTitle className="min-w-0 break-words leading-snug">
						<MathText text={stringProp(paper, "title")} />
					</CardTitle>
					{status ? (
						<ToneBadge tone={STATUS_TONE[status]}>
							{t(STATUS_KEY[status])}
						</ToneBadge>
					) : null}
				</div>
				{authors ? (
					<div className={cn("truncate", BLOCK_CAPTION_CLASS)}>{authors}</div>
				) : null}
				{meta ? (
					<div className={cn("truncate", BLOCK_CAPTION_CLASS)}>{meta}</div>
				) : null}
			</CardHeader>
			{tags.length > 0 || canOpenPath ? (
				<CardContent className="flex flex-wrap items-center gap-1.5">
					{tags.map((tag) => (
						<TagBadge key={tag}>{tag}</TagBadge>
					))}
					<SourceReference
						source={path}
						actionLabel={t("uiBlock.openPaper")}
						className="ms-auto"
						showUnopenableText={false}
					/>
				</CardContent>
			) : null}
		</Card>
	);
}
