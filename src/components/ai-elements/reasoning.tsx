"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/core/utils";

import { ExternalLink } from "./external-link";
import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
	isStreaming: boolean;
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
	const context = useContext(ReasoningContext);
	if (!context) {
		throw new Error("Reasoning components must be used within Reasoning");
	}
	return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
	isStreaming?: boolean;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
};

const AUTO_CLOSE_DELAY = 1000;

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
		const resolvedDefaultOpen = defaultOpen ?? isStreaming;
		// Track if defaultOpen was explicitly set to false (to prevent auto-open)
		const isExplicitlyClosed = defaultOpen === false;

		const [isOpen, setIsOpen] = useControllableState<boolean>({
			defaultProp: resolvedDefaultOpen,
			onChange: onOpenChange,
			prop: open,
		});

		const hasEverStreamedRef = useRef(isStreaming);
		const [hasAutoClosed, setHasAutoClosed] = useState(false);

		useEffect(() => {
			if (isStreaming) {
				hasEverStreamedRef.current = true;
			}
		}, [isStreaming]);

		// Auto-open when streaming starts (unless explicitly closed)
		useEffect(() => {
			if (isStreaming && !isOpen && !isExplicitlyClosed) {
				setIsOpen(true);
			}
		}, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

		// Auto-close when streaming ends (once only, and only if it ever streamed)
		useEffect(() => {
			if (
				hasEverStreamedRef.current &&
				!isStreaming &&
				isOpen &&
				!hasAutoClosed
			) {
				const timer = setTimeout(() => {
					setIsOpen(false);
					setHasAutoClosed(true);
				}, AUTO_CLOSE_DELAY);

				return () => clearTimeout(timer);
			}
		}, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

		const handleOpenChange = useCallback(
			(newOpen: boolean) => {
				setIsOpen(newOpen);
			},
			[setIsOpen],
		);

		const contextValue = useMemo(
			() => ({ isOpen, isStreaming, setIsOpen }),
			[isOpen, isStreaming, setIsOpen],
		);

		return (
			<ReasoningContext.Provider value={contextValue}>
				<Collapsible
					className={cn("not-prose mb-4", className)}
					onOpenChange={handleOpenChange}
					open={isOpen}
					{...props}
				>
					{children}
				</Collapsible>
			</ReasoningContext.Provider>
		);
	},
);

export type ReasoningTriggerProps = ComponentProps<
	typeof CollapsibleTrigger
> & {
	getThinkingMessage?: (isStreaming: boolean) => ReactNode;
};

export const ReasoningTrigger = memo(
	({
		className,
		children,
		getThinkingMessage,
		...props
	}: ReasoningTriggerProps) => {
		const { t } = useTranslation("aiElements");
		const { isStreaming, isOpen } = useReasoning();

		// Durations are never persisted (ACP replay has no timestamps), so the
		// label is two-state only: streaming shimmer vs. a static header.
		const defaultGetThinkingMessage = (streaming: boolean) => {
			if (streaming) {
				return <Shimmer duration={1}>{t("reasoning.thinking")}</Shimmer>;
			}
			return <p>{t("reasoning.thought")}</p>;
		};

		const renderThinkingMessage =
			getThinkingMessage ?? defaultGetThinkingMessage;

		return (
			<CollapsibleTrigger
				className={cn(
					"flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
					className,
				)}
				{...props}
			>
				{children ?? (
					<>
						<BrainIcon className="size-4" />
						{renderThinkingMessage(isStreaming)}
						<ChevronDownIcon
							className={cn(
								"size-4 transition-transform",
								isOpen ? "rotate-180" : "rotate-0",
							)}
						/>
					</>
				)}
			</CollapsibleTrigger>
		);
	},
);

export type ReasoningContentProps = ComponentProps<
	typeof CollapsibleContent
> & {
	children: string;
};

const streamdownPlugins = { cjk, code, math, mermaid };

export const ReasoningContent = memo(
	({ className, children, ...props }: ReasoningContentProps) => (
		<CollapsibleContent
			className={cn(
				"mt-4 text-sm",
				"data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
				className,
			)}
			{...props}
		>
			<Streamdown
				components={{ a: ExternalLink }}
				linkSafety={{ enabled: false }}
				plugins={streamdownPlugins}
			>
				{children}
			</Streamdown>
		</CollapsibleContent>
	),
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
