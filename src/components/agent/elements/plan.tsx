"use client";

import { CheckIcon, CircleIcon, LoaderCircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceDescription,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/components/ui/trace";

import { cn } from "@/lib/core/utils";

interface PlanContextValue {
	isStreaming: boolean;
}

const PlanContext = createContext<PlanContextValue | null>(null);

const usePlan = () => {
	const context = useContext(PlanContext);
	if (!context) {
		throw new Error("Plan components must be used within Plan");
	}
	return context;
};

export type PlanProps = Omit<
	ComponentProps<typeof TraceCollapsible>,
	"open" | "onOpenChange"
> & { open?: boolean; onOpenChange?: (open: boolean) => void } & {
	isStreaming?: boolean;
};

export const Plan = ({
	className,
	isStreaming = false,
	children,
	open,
	onOpenChange,
	...props
}: PlanProps) => {
	const contextValue = useMemo(() => ({ isStreaming }), [isStreaming]);

	return (
		<PlanContext.Provider value={contextValue}>
			<Trace className={cn("shadow-none", className)}>
				<TraceCollapsible
					data-slot="plan"
					{...props}
					{...(open === undefined
						? { onOpenChange }
						: { open, onOpenChange: onOpenChange ?? (() => {}) })}
				>
					{children}
				</TraceCollapsible>
			</Trace>
		</PlanContext.Provider>
	);
};

export type PlanHeaderProps = ComponentProps<"div">;

export const PlanHeader = ({ className, ...props }: PlanHeaderProps) => (
	<div
		className={cn("flex items-start justify-between", className)}
		data-slot="plan-header"
		{...props}
	/>
);

export type PlanTitleProps = Omit<
	ComponentProps<typeof TraceTitle>,
	"children"
> & {
	children: string;
};

export const PlanTitle = ({ children, ...props }: PlanTitleProps) => {
	const { isStreaming } = usePlan();

	return (
		<TraceLine status={isStreaming ? "running" : undefined}>
			<TraceTitle {...props}>{children}</TraceTitle>
		</TraceLine>
	);
};

export type PlanDescriptionProps = Omit<
	ComponentProps<typeof TraceDescription>,
	"children"
> & {
	children: string;
};

export const PlanDescription = ({
	className,
	children,
	...props
}: PlanDescriptionProps) => {
	return (
		<TraceDescription
			className={cn("text-balance", className)}
			data-slot="plan-description"
			{...props}
		>
			{children}
		</TraceDescription>
	);
};

export type PlanActionProps = ComponentProps<"div">;

export const PlanAction = (props: PlanActionProps) => (
	<div data-slot="plan-action" {...props} />
);

export type PlanContentProps = ComponentProps<"div">;

export const PlanContent = (props: PlanContentProps) => (
	<TraceCollapsibleContent>
		<Trace data-slot="plan-content" {...props} />
	</TraceCollapsibleContent>
);

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export type PlanStepProps = ComponentProps<"li"> & {
	status?: PlanStepStatus;
	children: ReactNode;
};

export const PlanStep = ({
	className,
	status = "pending",
	children,
	...props
}: PlanStepProps) => {
	const { t } = useTranslation("aiElements");
	const statusLabel = t(`plan.status.${status}`);
	const isCompleted = status === "completed";

	return (
		<li
			className={cn(
				"flex min-w-0 items-start gap-2 text-sm",
				status === "in_progress" && "text-foreground",
				status === "pending" && "text-muted-foreground",
				status === "completed" && "text-muted-foreground",
				className,
			)}
			data-slot="plan-step"
			{...props}
		>
			<TraceLine
				status={
					status === "in_progress"
						? "running"
						: status === "pending"
							? "pending"
							: undefined
				}
				className="items-start w-full"
			>
				<TraceIcon
					aria-hidden="true"
					className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
				>
					{isCompleted ? (
						<CheckIcon className="size-3.5 text-emerald-500" />
					) : status === "in_progress" ? (
						<LoaderCircleIcon className="size-3.5 animate-spin text-amber-500" />
					) : (
						<CircleIcon className="size-2.5 text-muted-foreground/50" />
					)}
				</TraceIcon>
				<TraceTitle
					className={cn(
						"min-w-0 break-words",
						isCompleted && "text-muted-foreground line-through",
					)}
				>
					{children}
				</TraceTitle>
				<span className="sr-only">{statusLabel}</span>
			</TraceLine>
		</li>
	);
};

export type PlanTriggerProps = ComponentProps<typeof TraceCollapsibleTrigger>;

export const PlanTrigger = ({ className, ...props }: PlanTriggerProps) => {
	const { t } = useTranslation("aiElements");

	return (
		<TraceCollapsibleTrigger className={className} {...props}>
			<span className="sr-only">{t("plan.toggle")}</span>
		</TraceCollapsibleTrigger>
	);
};
