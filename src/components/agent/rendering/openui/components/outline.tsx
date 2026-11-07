/** biome-ignore-all lint/suspicious/noArrayIndexKey: outline rows render in model order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { useOpenUiSource } from "../source-context";
import { stringProp } from "./shared";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function OutlineNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const onOpenSource = useOpenUiSource();
	const sections = Array.isArray(node.props.sections)
		? node.props.sections.filter(isRecord)
		: [];

	return (
		<div className="min-w-0 space-y-1.5">
			{stringProp(node.props, "title") ? (
				<div className="text-sm font-medium">
					{stringProp(node.props, "title")}
				</div>
			) : null}
			<ol className="space-y-0.5 text-sm">
				{sections.map((section, index) => {
					const level = typeof section.level === "number" ? section.level : 1;
					const page =
						typeof section.page === "number" ? section.page : undefined;
					const source =
						typeof section.source === "string" ? section.source : "";
					const label = (
						<span className="flex min-w-0 items-baseline justify-between gap-2">
							<span className="min-w-0 truncate">
								{stringProp(section, "title")}
							</span>
							{page ? (
								<span className="shrink-0 text-xs text-muted-foreground">
									{t("uiBlock.page", { page })}
								</span>
							) : null}
						</span>
					);
					return (
						<li
							key={`${String(section.title)}-${index}`}
							style={{ paddingLeft: `${Math.max(0, level - 1) * 0.75}rem` }}
						>
							{source && onOpenSource ? (
								<button
									type="button"
									className="w-full rounded-sm text-left hover:bg-muted/50"
									onClick={() => onOpenSource(source)}
								>
									{label}
								</button>
							) : (
								label
							)}
						</li>
					);
				})}
			</ol>
		</div>
	);
}
