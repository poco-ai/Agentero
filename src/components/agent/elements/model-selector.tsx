import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/core/utils";

export type ModelSelectorProps = ComponentProps<typeof Dialog>;

export const ModelSelector = (props: ModelSelectorProps) => (
	<Dialog {...props} />
);

export type ModelSelectorTriggerProps = ComponentProps<typeof DialogTrigger>;

export const ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => (
	<DialogTrigger {...props} />
);

export type ModelSelectorContentProps = ComponentProps<typeof DialogContent> & {
	title?: ReactNode;
	header?: ReactNode;
};

export const ModelSelectorContent = ({
	className,
	children,
	title,
	header,
	...props
}: ModelSelectorContentProps) => {
	const { t } = useTranslation("aiElements");

	return (
		<DialogContent
			aria-describedby={undefined}
			className={cn(
				"outline! border-none! gap-0 p-0 outline-border! outline-solid!",
				className,
			)}
			{...props}
		>
			<DialogTitle className="sr-only">
				{title ?? t("modelSelector.label")}
			</DialogTitle>
			{header}
			<Command className="**:data-[slot=command-input-wrapper]:h-auto">
				{children}
			</Command>
		</DialogContent>
	);
};

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>;

export const ModelSelectorInput = ({
	className,
	...props
}: ModelSelectorInputProps) => (
	<CommandInput className={cn("h-auto py-3.5", className)} {...props} />
);

export type ModelSelectorListProps = ComponentProps<typeof CommandList>;

export const ModelSelectorList = (props: ModelSelectorListProps) => (
	<CommandList {...props} />
);

export type ModelSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps) => (
	<CommandEmpty {...props} />
);

export type ModelSelectorGroupProps = ComponentProps<typeof CommandGroup>;

export const ModelSelectorGroup = (props: ModelSelectorGroupProps) => (
	<CommandGroup {...props} />
);

export type ModelSelectorItemProps = ComponentProps<typeof CommandItem>;

export const ModelSelectorItem = (props: ModelSelectorItemProps) => (
	<CommandItem {...props} />
);
