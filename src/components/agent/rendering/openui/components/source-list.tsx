/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only sources render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { useOpenUiSource } from "../source-context";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function SourceListNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const onOpenSource = useOpenUiSource();
	const sources = Array.isArray(node.props.sources)
		? node.props.sources.filter(isRecord)
		: [];
	return (
		<ol className="space-y-1.5 text-sm">
			{sources.map((source, index) => {
				const path = typeof source.path === "string" ? source.path : "";
				return (
					<li key={`${String(source.label)}-${index}`} className="min-w-0">
						{path && onOpenSource ? (
							<button
								type="button"
								className="text-left font-medium text-primary underline underline-offset-2"
								aria-label={t("uiBlock.openSource")}
								onClick={() => onOpenSource(path)}
							>
								{String(source.label ?? "")}
							</button>
						) : (
							<span className="font-medium">{String(source.label ?? "")}</span>
						)}
						{source.detail ? (
							<span className="ml-1.5 text-xs text-muted-foreground">
								{String(source.detail)}
							</span>
						) : null}
					</li>
				);
			})}
		</ol>
	);
}
