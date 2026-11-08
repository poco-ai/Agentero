/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only sources render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isOpenUiSourceTarget } from "@/lib/agent/openui/source";
import { cn } from "@/lib/core/utils";
import { useOpenUiSource } from "../source-context";
import { ROW_LINK_CLASS } from "../styles";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROW_CLASS =
	"flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 rounded-md px-1.5 py-1 text-left";

export function SourceListNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const onOpenSource = useOpenUiSource();
	const sources = Array.isArray(node.props.sources)
		? node.props.sources.filter(isRecord)
		: [];
	return (
		<ol className="space-y-0.5 text-sm">
			{sources.map((source, index) => {
				const path = typeof source.path === "string" ? source.path : "";
				const canOpen =
					Boolean(path) && Boolean(onOpenSource) && isOpenUiSourceTarget(path);
				const label = String(source.label ?? "");
				const detail = typeof source.detail === "string" ? source.detail : "";
				return (
					<li key={`${label}-${index}`} className="min-w-0">
						{canOpen ? (
							<button
								type="button"
								className={cn(ROW_CLASS, ROW_LINK_CLASS)}
								aria-label={`${t("uiBlock.openSource")}: ${label}`}
								onClick={() => onOpenSource?.(path)}
							>
								<span className="inline-flex min-w-0 items-center gap-0.5 font-medium text-primary">
									<span className="truncate">{label}</span>
									<ArrowUpRight
										className="size-3 shrink-0 opacity-70"
										aria-hidden
									/>
								</span>
								{detail ? (
									<span className="text-xs text-muted-foreground">
										{detail}
									</span>
								) : null}
							</button>
						) : (
							<div className={ROW_CLASS}>
								<span className="min-w-0 truncate font-medium">{label}</span>
								{detail ? (
									<span className="text-xs text-muted-foreground">
										{detail}
									</span>
								) : null}
							</div>
						)}
					</li>
				);
			})}
		</ol>
	);
}
