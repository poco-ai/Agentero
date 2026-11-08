/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only steps render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkdownText } from "../markdown-text";
import { stringList, stringProp } from "./shared";

export function StepsNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const steps = stringList(node.props.steps);
	const title = stringProp(node.props, "title");
	return (
		<Card size="sm" className="w-full gap-2">
			{title ? (
				<CardHeader>
					<CardTitle className="break-words">{title}</CardTitle>
				</CardHeader>
			) : null}
			<CardContent>
				{steps.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t("uiBlock.stepsEmpty")}
					</p>
				) : (
					<ol className="space-y-0">
						{steps.map((step, index) => (
							<li
								key={`${index}-${step}`}
								className="relative flex gap-2.5 pb-3 last:pb-0"
							>
								{index < steps.length - 1 ? (
									<span
										className="absolute top-5 bottom-0 left-[0.625rem] w-px bg-border"
										aria-hidden
									/>
								) : null}
								<span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-[11px] font-medium text-foreground tabular-nums">
									{index + 1}
								</span>
								<div className="min-w-0 flex-1 pt-0.5">
									<MarkdownText text={step} />
								</div>
							</li>
						))}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}
