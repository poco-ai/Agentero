/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only steps render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { stringList, stringProp } from "./shared";

export function StepsNode({ node }: { node: ElementNode }) {
	const { t } = useTranslation("agent");
	const steps = stringList(node.props.steps);
	return (
		<Card size="sm" className="w-full gap-2 py-3">
			<CardHeader className="px-3 pb-0">
				<CardTitle className="text-sm">
					{stringProp(node.props, "title")}
				</CardTitle>
			</CardHeader>
			<CardContent className="px-3">
				{steps.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t("uiBlock.stepsEmpty")}
					</p>
				) : (
					<ol className="space-y-2.5">
						{steps.map((step, index) => (
							<li key={`${index}-${step}`} className="flex gap-2.5">
								<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
									{index + 1}
								</span>
								<span className="min-w-0 text-sm leading-relaxed whitespace-pre-wrap">
									{step}
								</span>
							</li>
						))}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}
