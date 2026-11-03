"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { BrainIcon } from "lucide-react";
import {
	type ComponentProps,
	createContext,
	memo,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/agent/rendering/message-response";
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

interface ReasoningContextValue {
	isStreaming: boolean;
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
}
const ReasoningContext = createContext<ReasoningContextValue | null>(null);
export function useReasoning() {
	const context = useContext(ReasoningContext);
	if (!context)
		throw new Error("Reasoning components must be used within Reasoning");
	return context;
}
export type ReasoningProps = Omit<
	ComponentProps<typeof TraceCollapsible>,
	"open" | "onOpenChange"
> & {
	isStreaming?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
};
export const Reasoning = memo(
	({
		className,
		isStreaming = false,
		open,
		defaultOpen,
		onOpenChange,
		children,
		...props
	}: ReasoningProps) => {
		const [isOpen, setIsOpen] = useControllableState({
			defaultProp: defaultOpen ?? isStreaming,
			prop: open,
			onChange: onOpenChange,
		});
		const previousStreaming = useRef(isStreaming);
		const manuallyChanged = useRef(false);
		const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
			undefined,
		);
		useEffect(() => {
			const started = isStreaming && !previousStreaming.current;
			const ended = !isStreaming && previousStreaming.current;
			previousStreaming.current = isStreaming;
			if (manuallyChanged.current || defaultOpen === false) return;
			if (started) setIsOpen(true);
			if (ended) {
				closeTimer.current = setTimeout(() => setIsOpen(false), 1000);
				return () => clearTimeout(closeTimer.current);
			}
		}, [isStreaming, defaultOpen, setIsOpen]);
		const value = useMemo(
			() => ({ isStreaming, isOpen, setIsOpen }),
			[isStreaming, isOpen, setIsOpen],
		);
		return (
			<ReasoningContext.Provider value={value}>
				<Trace className={cn("not-prose mb-4", className)}>
					<TraceCollapsible
						{...props}
						open={isOpen}
						onOpenChange={(next) => {
							manuallyChanged.current = true;
							clearTimeout(closeTimer.current);
							setIsOpen(next);
						}}
					>
						{children}
					</TraceCollapsible>
				</Trace>
			</ReasoningContext.Provider>
		);
	},
);
export type ReasoningTriggerProps = ComponentProps<
	typeof TraceCollapsibleTrigger
> & {
	getThinkingMessage?: (isStreaming: boolean) => ReactNode;
	swapIconOnHover?: boolean;
};
export const ReasoningTrigger = memo(
	({
		className,
		children,
		getThinkingMessage,
		swapIconOnHover: _swapIconOnHover,
		...props
	}: ReasoningTriggerProps) => {
		const { t } = useTranslation("aiElements");
		const { isStreaming } = useReasoning();
		return (
			<TraceCollapsibleTrigger className={className} {...props}>
				<TraceLine status={isStreaming ? "running" : undefined}>
					<TraceIcon>
						<BrainIcon />
					</TraceIcon>
					<TraceTitle className="font-medium text-xs">
						{children ??
							getThinkingMessage?.(isStreaming) ??
							t(isStreaming ? "reasoning.thinking" : "reasoning.thought")}
					</TraceTitle>
				</TraceLine>
			</TraceCollapsibleTrigger>
		);
	},
);
export type ReasoningContentProps = ComponentProps<
	typeof TraceCollapsibleContent
> & { children: string; onOpenSource?: (source: string) => void };
export const ReasoningContent = memo(
	({ className, children, onOpenSource, ...props }: ReasoningContentProps) => {
		const { isStreaming } = useReasoning();
		return (
			<TraceCollapsibleContent className={cn("text-sm", className)} {...props}>
				<MessageResponse
					className="text-sm"
					isAnimating={isStreaming}
					onOpenSource={onOpenSource}
				>
					{children}
				</MessageResponse>
			</TraceCollapsibleContent>
		);
	},
);
Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
