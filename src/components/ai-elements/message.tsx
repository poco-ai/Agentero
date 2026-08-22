"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import { normalizeMarkdownMath } from "@/lib/markdown/math-normalize";

import { ExternalLink } from "./external-link";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
	from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
	<div
		className={cn(
			"group flex w-full max-w-[95%] flex-col gap-2",
			from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
			className,
		)}
		{...props}
	/>
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
	children,
	className,
	...props
}: MessageContentProps) => (
	<div
		className={cn(
			"flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
			"group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-black/5 group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground dark:group-[.is-user]:bg-white/10",
			"group-[.is-assistant]:text-foreground",
			className,
		)}
		{...props}
	>
		{children}
	</div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
	className,
	children,
	...props
}: MessageActionsProps) => (
	<div className={cn("flex items-center gap-1", className)} {...props}>
		{children}
	</div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
	tooltip?: string;
	label?: string;
};

export const MessageAction = ({
	tooltip,
	children,
	label,
	variant = "ghost",
	size = "icon-sm",
	...props
}: MessageActionProps) => {
	const button = (
		<Button size={size} type="button" variant={variant} {...props}>
			{children}
			<span className="sr-only">{label || tooltip}</span>
		</Button>
	);

	if (tooltip) {
		return (
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent>
						<p>{tooltip}</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		);
	}

	return button;
};

interface MessageBranchContextType {
	currentBranch: number;
	totalBranches: number;
	goToPrevious: () => void;
	goToNext: () => void;
	branches: ReactElement[];
	setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
	null,
);

const useMessageBranch = () => {
	const context = useContext(MessageBranchContext);

	if (!context) {
		throw new Error(
			"MessageBranch components must be used within MessageBranch",
		);
	}

	return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
	defaultBranch?: number;
	onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
	defaultBranch = 0,
	onBranchChange,
	className,
	...props
}: MessageBranchProps) => {
	const [currentBranch, setCurrentBranch] = useState(defaultBranch);
	const [branches, setBranches] = useState<ReactElement[]>([]);

	const handleBranchChange = useCallback(
		(newBranch: number) => {
			setCurrentBranch(newBranch);
			onBranchChange?.(newBranch);
		},
		[onBranchChange],
	);

	const goToPrevious = useCallback(() => {
		const newBranch =
			currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
		handleBranchChange(newBranch);
	}, [currentBranch, branches.length, handleBranchChange]);

	const goToNext = useCallback(() => {
		const newBranch =
			currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
		handleBranchChange(newBranch);
	}, [currentBranch, branches.length, handleBranchChange]);

	const contextValue = useMemo<MessageBranchContextType>(
		() => ({
			branches,
			currentBranch,
			goToNext,
			goToPrevious,
			setBranches,
			totalBranches: branches.length,
		}),
		[branches, currentBranch, goToNext, goToPrevious],
	);

	return (
		<MessageBranchContext.Provider value={contextValue}>
			<div
				className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
				{...props}
			/>
		</MessageBranchContext.Provider>
	);
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
	children,
	...props
}: MessageBranchContentProps) => {
	const { currentBranch, setBranches, branches } = useMessageBranch();
	const childrenArray = useMemo(
		() => (Array.isArray(children) ? children : [children]),
		[children],
	);

	// Use useEffect to update branches when they change
	useEffect(() => {
		if (branches.length !== childrenArray.length) {
			setBranches(childrenArray);
		}
	}, [childrenArray, branches, setBranches]);

	return childrenArray.map((branch, index) => (
		<div
			className={cn(
				"grid gap-2 overflow-hidden [&>div]:pb-0",
				index === currentBranch ? "block" : "hidden",
			)}
			key={branch.key}
			{...props}
		>
			{branch}
		</div>
	));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
	className,
	...props
}: MessageBranchSelectorProps) => {
	const { totalBranches } = useMessageBranch();

	// Don't render if there's only one branch
	if (totalBranches <= 1) {
		return null;
	}

	return (
		<ButtonGroup
			className={cn(
				"[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
				className,
			)}
			orientation="horizontal"
			{...props}
		/>
	);
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
	children,
	...props
}: MessageBranchPreviousProps) => {
	const { t } = useTranslation("aiElements");
	const { goToPrevious, totalBranches } = useMessageBranch();

	return (
		<Button
			aria-label={t("message.previousBranch")}
			disabled={totalBranches <= 1}
			onClick={goToPrevious}
			size="icon-sm"
			type="button"
			variant="ghost"
			{...props}
		>
			{children ?? <ChevronLeftIcon size={14} />}
		</Button>
	);
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
	children,
	...props
}: MessageBranchNextProps) => {
	const { t } = useTranslation("aiElements");
	const { goToNext, totalBranches } = useMessageBranch();

	return (
		<Button
			aria-label={t("message.nextBranch")}
			disabled={totalBranches <= 1}
			onClick={goToNext}
			size="icon-sm"
			type="button"
			variant="ghost"
			{...props}
		>
			{children ?? <ChevronRightIcon size={14} />}
		</Button>
	);
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
	className,
	...props
}: MessageBranchPageProps) => {
	const { t } = useTranslation("aiElements");
	const { currentBranch, totalBranches } = useMessageBranch();

	return (
		<ButtonGroupText
			className={cn(
				"border-none bg-transparent text-muted-foreground shadow-none",
				className,
			)}
			{...props}
		>
			{t("message.branchIndicator", {
				current: currentBranch + 1,
				total: totalBranches,
			})}
		</ButtonGroupText>
	);
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

/**
 * KaTeX via Streamdown. Default `@streamdown/math` turns single-dollar off
 * (`singleDollarTextMath: false`), so common agent math like `$\pi_\theta$`
 * rendered as raw text. Enable `$…$` for inline and keep `$$…$$` for display.
 */
const streamdownMath = createMathPlugin({ singleDollarTextMath: true });
const streamdownPlugins = {
	cjk,
	code,
	math: streamdownMath,
	mermaid,
};

export const MessageResponse = memo(
	({ className, children, ...props }: MessageResponseProps) => {
		const content =
			typeof children === "string" ? normalizeMarkdownMath(children) : children;
		return (
			<Streamdown
				className={cn(
					// Keep the renderer's height content-driven. `size-full` sets
					// height: 100%, which can clip later blocks in auto-sized embeds.
					"w-full min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
					className,
				)}
				components={{ a: ExternalLink }}
				linkSafety={{ enabled: false }}
				plugins={streamdownPlugins}
				{...props}
			>
				{content}
			</Streamdown>
		);
	},
	(prevProps, nextProps) =>
		prevProps.children === nextProps.children &&
		nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
	className,
	children,
	...props
}: MessageToolbarProps) => (
	<div
		className={cn(
			"mt-4 flex w-full items-center justify-between gap-4",
			className,
		)}
		{...props}
	>
		{children}
	</div>
);
