"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
	CheckCircleIcon,
	CircleIcon,
	ClockIcon,
	WrenchIcon,
	XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock } from "@/components/agent/rendering/code-block";
import { Badge } from "@/components/ui/badge";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/components/ui/trace";
import { cn } from "@/lib/core/utils";

export type ToolProps = Omit<
	ComponentProps<typeof TraceCollapsible>,
	"open" | "onOpenChange"
> & { open?: boolean; onOpenChange?: (open: boolean) => void };

export const Tool = ({
	className,
	open,
	onOpenChange,
	...props
}: ToolProps) => (
	<Trace className={cn("not-prose mb-1.5", className)}>
		<TraceCollapsible
			{...props}
			{...(open === undefined
				? { onOpenChange }
				: { open, onOpenChange: onOpenChange ?? (() => {}) })}
		/>
	</Trace>
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
	title?: string;
	className?: string;
	swapIconOnHover?: boolean;
} & (
	| { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
	| {
			type: DynamicToolUIPart["type"];
			state: DynamicToolUIPart["state"];
			toolName: string;
	  }
);

const statusLabelKeys = {
	"approval-requested": "tool.status.awaitingApproval",
	"approval-responded": "tool.status.responded",
	"input-available": "tool.status.running",
	"input-streaming": "tool.status.pending",
	"output-available": "tool.status.completed",
	"output-denied": "tool.status.denied",
	"output-error": "tool.status.error",
} as const satisfies Record<ToolPart["state"], string>;

const statusIcons: Record<ToolPart["state"], ReactNode> = {
	"approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
	"approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
	"input-available": <ClockIcon className="size-4 animate-pulse" />,
	"input-streaming": <CircleIcon className="size-4" />,
	"output-available": (
		<CheckCircleIcon className="size-4 text-muted-foreground" />
	),
	"output-denied": <XCircleIcon className="size-4 text-orange-600" />,
	"output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolPart["state"], label: string) => (
	<Badge
		className="h-5 gap-1 rounded-full bg-black/5 px-1.5 py-0 text-caption font-normal text-foreground dark:bg-white/10"
		variant="secondary"
	>
		<span className="[&>svg]:size-3">{statusIcons[status]}</span>
		{label}
	</Badge>
);

export const ToolHeader = ({
	className,
	title,
	type,
	state,
	toolName,
	swapIconOnHover: _swapIconOnHover,
	...props
}: ToolHeaderProps) => {
	const { t } = useTranslation("aiElements");
	const name =
		type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
	const failed = state === "output-denied" || state === "output-error";
	const running = state === "input-available" || state === "input-streaming";
	return (
		<TraceCollapsibleTrigger className={className} {...props}>
			<TraceLine status={failed ? "error" : running ? "running" : undefined}>
				<TraceIcon>
					<WrenchIcon />
				</TraceIcon>
				<TraceTitle className="font-medium text-xs">{title ?? name}</TraceTitle>
				<span className="sr-only">{t(statusLabelKeys[state])}</span>
				{failed ? getStatusBadge(state, t(statusLabelKeys[state])) : null}
			</TraceLine>
		</TraceCollapsibleTrigger>
	);
};

export type ToolContentProps = ComponentProps<typeof TraceCollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
	<TraceCollapsibleContent
		className={cn("space-y-2 text-popover-foreground", className)}
		{...props}
	/>
);

export type ToolInputProps = ComponentProps<"div"> & {
	input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
	const { t } = useTranslation("aiElements");

	return (
		<div className={cn("space-y-1 overflow-hidden", className)} {...props}>
			<h4 className="font-medium text-caption text-muted-foreground uppercase tracking-wide">
				{t("tool.parameters")}
			</h4>
			<div className="rounded bg-muted/50 text-xs">
				<CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
			</div>
		</div>
	);
};

export type ToolOutputProps = ComponentProps<"div"> & {
	output: ToolPart["output"];
	errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
	className,
	output,
	errorText,
	...props
}: ToolOutputProps) => {
	const { t } = useTranslation("aiElements");

	if (!(output || errorText)) {
		return null;
	}

	let Output = <div>{output as ReactNode}</div>;

	if (typeof output === "object" && !isValidElement(output)) {
		Output = (
			<CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
		);
	} else if (typeof output === "string") {
		Output = <CodeBlock code={output} language="json" />;
	}

	return (
		<div className={cn("space-y-1", className)} {...props}>
			<h4 className="font-medium text-caption text-muted-foreground uppercase tracking-wide">
				{errorText ? t("tool.error") : t("tool.result")}
			</h4>
			<div
				className={cn(
					"overflow-x-auto rounded text-caption [&_table]:w-full",
					errorText
						? "bg-destructive/10 text-destructive"
						: "bg-muted/50 text-foreground",
				)}
			>
				{errorText && <div className="px-1.5 py-1">{errorText}</div>}
				{Output}
			</div>
		</div>
	);
};
