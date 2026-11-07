/** biome-ignore-all lint/suspicious/noArrayIndexKey: claims render in model order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/core/utils";
import { MarkdownText } from "../markdown-text";
import { useOpenUiSource } from "../source-context";
import { stringProp } from "./shared";

const STATUS_KEY = {
	supports: "uiBlock.claimStatus.supports",
	contradicts: "uiBlock.claimStatus.contradicts",
	mixed: "uiBlock.claimStatus.mixed",
	unclear: "uiBlock.claimStatus.unclear",
} as const;

const STATUS_CLASS = {
	supports:
		"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	contradicts: "border-destructive/35 bg-destructive/10 text-destructive",
	mixed:
		"border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	unclear: "border-border bg-muted text-muted-foreground",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function ClaimListNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const onOpenSource = useOpenUiSource();
	const claims = Array.isArray(node.props.claims)
		? node.props.claims.filter(isRecord)
		: [];

	return (
		<div className="min-w-0 space-y-2">
			{stringProp(node.props, "title") ? (
				<div className="text-sm font-medium">
					{stringProp(node.props, "title")}
				</div>
			) : null}
			<ul className="space-y-2">
				{claims.map((claim, index) => {
					const status =
						typeof claim.status === "string" && claim.status in STATUS_KEY
							? (claim.status as keyof typeof STATUS_KEY)
							: "unclear";
					const source = typeof claim.source === "string" ? claim.source : "";
					return (
						<li
							key={`${String(claim.claim)}-${index}`}
							className="rounded-md border bg-muted/10 px-3 py-2"
						>
							<div className="flex min-w-0 items-start gap-2">
								<Badge
									variant="outline"
									className={cn(
										"h-5 shrink-0 rounded-md px-1.5 text-[11px]",
										STATUS_CLASS[status],
									)}
								>
									{t(STATUS_KEY[status])}
								</Badge>
								<div className="min-w-0 flex-1">
									<MarkdownText text={stringProp(claim, "claim")} />
								</div>
							</div>
							{stringProp(claim, "evidence") ? (
								<div className="mt-1.5">
									<MarkdownText
										text={stringProp(claim, "evidence")}
										className="text-xs text-muted-foreground"
									/>
								</div>
							) : null}
							{source && onOpenSource ? (
								<button
									type="button"
									className="mt-1 text-xs text-primary underline underline-offset-2"
									onClick={() => onOpenSource(source)}
								>
									{t("uiBlock.openSource")}
								</button>
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
