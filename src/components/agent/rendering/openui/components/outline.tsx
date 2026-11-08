/** biome-ignore-all lint/suspicious/noArrayIndexKey: outline rows render in model order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import { useOpenUiSource } from "../source-context";
import { BLOCK_TITLE_CLASS, ROW_LINK_CLASS } from "../styles";
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
	const title = stringProp(node.props, "title");

	return (
		<div className="min-w-0 space-y-1.5">
			{title ? <div className={BLOCK_TITLE_CLASS}>{title}</div> : null}
			<ol className="space-y-0.5 text-sm">
				{sections.map((section, index) => {
					const level =
						typeof section.level === "number"
							? Math.max(1, Math.floor(section.level))
							: 1;
					const page =
						typeof section.page === "number" ? section.page : undefined;
					const source =
						typeof section.source === "string" ? section.source : "";
					const label = (
						<>
							<span className="min-w-0 truncate">
								{stringProp(section, "title")}
							</span>
							{page !== undefined ? (
								<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
									{t("uiBlock.page", { page })}
								</span>
							) : null}
						</>
					);
					const rowClass =
						"flex w-full min-w-0 items-baseline justify-between gap-2 rounded-md px-1.5 py-1 text-left";
					return (
						<li
							key={`${String(section.title)}-${index}`}
							style={{ paddingLeft: `${Math.max(0, level - 1) * 0.75}rem` }}
						>
							{source && onOpenSource ? (
								<button
									type="button"
									className={cn(rowClass, ROW_LINK_CLASS)}
									onClick={() => onOpenSource(source)}
								>
									{label}
								</button>
							) : (
								<div className={rowClass}>{label}</div>
							)}
						</li>
					);
				})}
			</ol>
		</div>
	);
}
