"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/core/utils";
import { MarkdownText } from "../markdown-text";
import {
	BLOCK_TITLE_CLASS,
	type OpenUiCalloutTone,
	resolveCalloutTone,
	TONE_ICON_CLASS,
	TONE_SURFACE_CLASS,
} from "../styles";
import { stringProp } from "./shared";

const TONE_ICON_COMPONENT: Record<
	OpenUiCalloutTone,
	ComponentType<{ className?: string }>
> = {
	info: Info,
	success: CircleCheck,
	warning: TriangleAlert,
	danger: CircleX,
};

export function CalloutNode({ node }: { node: ElementNode }) {
	const tone = resolveCalloutTone(stringProp(node.props, "tone"));
	const Icon = TONE_ICON_COMPONENT[tone];
	const title = stringProp(node.props, "title");
	const body = stringProp(node.props, "body");
	return (
		<div
			className={cn("rounded-lg border px-3 py-2.5", TONE_SURFACE_CLASS[tone])}
		>
			<div className="flex items-start gap-2">
				<Icon
					className={cn("mt-0.5 size-3.5 shrink-0", TONE_ICON_CLASS[tone])}
					aria-hidden
				/>
				<div className="min-w-0 flex-1">
					{title ? <div className={BLOCK_TITLE_CLASS}>{title}</div> : null}
					{body ? (
						<MarkdownText
							text={body}
							className="mt-1 text-sm text-muted-foreground"
						/>
					) : null}
				</div>
			</div>
		</div>
	);
}
