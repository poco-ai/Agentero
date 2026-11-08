/** biome-ignore-all lint/suspicious/noArrayIndexKey: claims render in model order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import { MarkdownText } from "../markdown-text";
import {
	BLOCK_TITLE_CLASS,
	NESTED_SURFACE_CLASS,
	type OpenUiTone,
} from "../styles";
import { stringProp } from "./shared";
import { SourceReference } from "./source-reference";
import { ToneBadge } from "./tone-badge";

const STATUS_KEY = {
	supports: "uiBlock.claimStatus.supports",
	contradicts: "uiBlock.claimStatus.contradicts",
	mixed: "uiBlock.claimStatus.mixed",
	unclear: "uiBlock.claimStatus.unclear",
} as const;

const STATUS_TONE: Record<keyof typeof STATUS_KEY, OpenUiTone> = {
	supports: "success",
	contradicts: "danger",
	mixed: "warning",
	unclear: "neutral",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function ClaimListNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const claims = Array.isArray(node.props.claims)
		? node.props.claims.filter(isRecord)
		: [];
	const title = stringProp(node.props, "title");

	return (
		<div className="min-w-0 space-y-2">
			{title ? <div className={BLOCK_TITLE_CLASS}>{title}</div> : null}
			<ul className="space-y-2">
				{claims.map((claim, index) => {
					const status =
						typeof claim.status === "string" && claim.status in STATUS_KEY
							? (claim.status as keyof typeof STATUS_KEY)
							: "unclear";
					const evidence = stringProp(claim, "evidence");
					const source = stringProp(claim, "source");
					return (
						<li
							key={`${String(claim.claim)}-${index}`}
							className={cn(NESTED_SURFACE_CLASS, "px-3 py-2.5")}
						>
							<div className="flex items-start gap-2">
								<ToneBadge tone={STATUS_TONE[status]}>
									{t(STATUS_KEY[status])}
								</ToneBadge>
								<div className="min-w-0 flex-1 space-y-1.5">
									<MarkdownText text={stringProp(claim, "claim")} />
									{evidence ? (
										<div className="border-l-2 border-border/60 pl-2.5">
											<MarkdownText
												text={evidence}
												className="text-xs text-muted-foreground"
											/>
										</div>
									) : null}
									<SourceReference
										source={source}
										actionLabel={t("uiBlock.openSource")}
									/>
								</div>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
