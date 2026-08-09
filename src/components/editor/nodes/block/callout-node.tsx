"use client";

import {
	Bug,
	CheckCircle2,
	CircleHelp,
	ClipboardList,
	Flame,
	Info,
	Lightbulb,
	ListChecks,
	type LucideIcon,
	MessageSquareQuote,
	Pencil,
	TriangleAlert,
	XCircle,
	Zap,
} from "lucide-react";
import {
	PlateElement,
	type PlateElementProps,
	useEditorRef,
	useReadOnly,
} from "platejs/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
	Command,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/core/utils";
import { updateCalloutMetadata } from "@/lib/markdown/callout";

type CalloutTheme = {
	Icon: LucideIcon;
	className: string;
	iconClassName: string;
};

const CALLOUT_THEMES: Record<string, CalloutTheme> = {
	note: {
		Icon: Pencil,
		className: "border-blue-500/60 bg-blue-500/10",
		iconClassName: "text-blue-600 dark:text-blue-400",
	},
	abstract: {
		Icon: ClipboardList,
		className: "border-cyan-500/60 bg-cyan-500/10",
		iconClassName: "text-cyan-600 dark:text-cyan-400",
	},
	info: {
		Icon: Info,
		className: "border-blue-500/60 bg-blue-500/10",
		iconClassName: "text-blue-600 dark:text-blue-400",
	},
	todo: {
		Icon: ListChecks,
		className: "border-blue-500/60 bg-blue-500/10",
		iconClassName: "text-blue-600 dark:text-blue-400",
	},
	tip: {
		Icon: Lightbulb,
		className: "border-cyan-500/60 bg-cyan-500/10",
		iconClassName: "text-cyan-600 dark:text-cyan-400",
	},
	success: {
		Icon: CheckCircle2,
		className: "border-emerald-500/60 bg-emerald-500/10",
		iconClassName: "text-emerald-600 dark:text-emerald-400",
	},
	question: {
		Icon: CircleHelp,
		className: "border-amber-500/60 bg-amber-500/10",
		iconClassName: "text-amber-600 dark:text-amber-400",
	},
	warning: {
		Icon: TriangleAlert,
		className: "border-amber-500/60 bg-amber-500/10",
		iconClassName: "text-amber-600 dark:text-amber-400",
	},
	failure: {
		Icon: XCircle,
		className: "border-red-500/60 bg-red-500/10",
		iconClassName: "text-red-600 dark:text-red-400",
	},
	danger: {
		Icon: Zap,
		className: "border-red-500/60 bg-red-500/10",
		iconClassName: "text-red-600 dark:text-red-400",
	},
	bug: {
		Icon: Bug,
		className: "border-red-500/60 bg-red-500/10",
		iconClassName: "text-red-600 dark:text-red-400",
	},
	example: {
		Icon: ListChecks,
		className: "border-violet-500/60 bg-violet-500/10",
		iconClassName: "text-violet-600 dark:text-violet-400",
	},
	quote: {
		Icon: MessageSquareQuote,
		className: "border-slate-500/60 bg-slate-500/10",
		iconClassName: "text-slate-600 dark:text-slate-400",
	},
	important: {
		Icon: Flame,
		className: "border-fuchsia-500/60 bg-fuchsia-500/10",
		iconClassName: "text-fuchsia-600 dark:text-fuchsia-400",
	},
};

const GENERIC_THEME: CalloutTheme = {
	Icon: Info,
	className: "border-border bg-muted/45",
	iconClassName: "text-muted-foreground",
};

const CALLOUT_TYPE_KEYS = {
	note: "callout.types.note",
	abstract: "callout.types.abstract",
	info: "callout.types.info",
	todo: "callout.types.todo",
	tip: "callout.types.tip",
	success: "callout.types.success",
	question: "callout.types.question",
	warning: "callout.types.warning",
	failure: "callout.types.failure",
	danger: "callout.types.danger",
	bug: "callout.types.bug",
	example: "callout.types.example",
	quote: "callout.types.quote",
	important: "callout.types.important",
} as const;

type KnownCalloutType = keyof typeof CALLOUT_TYPE_KEYS;

const CALLOUT_TYPES = Object.keys(CALLOUT_TYPE_KEYS) as KnownCalloutType[];

type CalloutElementData = {
	calloutType?: string;
	calloutTypeRaw?: string;
	title?: string;
	variant?: string;
};

export function CalloutElement(props: PlateElementProps) {
	const { t } = useTranslation("editor");
	const editor = useEditorRef();
	const readOnly = useReadOnly();
	const element = props.element as typeof props.element & CalloutElementData;
	const type = (element.calloutType || element.variant || "note").toLowerCase();
	const typeRaw = element.calloutTypeRaw || element.variant || type;
	const theme = CALLOUT_THEMES[type] ?? GENERIC_THEME;
	const titleKey = CALLOUT_TYPE_KEYS[type as KnownCalloutType];
	const title = element.title || (titleKey ? t(titleKey) : typeRaw);
	const [typeOpen, setTypeOpen] = React.useState(false);
	const [titleEditing, setTitleEditing] = React.useState(false);
	const [titleDraft, setTitleDraft] = React.useState(element.title ?? "");
	const cancelTitleEditRef = React.useRef(false);

	const handleTypeSelect = (nextType: KnownCalloutType) => {
		if (nextType === type) {
			setTypeOpen(false);
			return;
		}
		updateCalloutMetadata(editor, props.element, {
			title: element.title ?? "",
			typeRaw: nextType,
		});
		setTypeOpen(false);
	};

	const handleTitleFocus = () => {
		cancelTitleEditRef.current = false;
		setTitleDraft(element.title ?? "");
		setTitleEditing(true);
	};

	const handleTitleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
		const cancelled = cancelTitleEditRef.current;
		cancelTitleEditRef.current = false;
		setTitleEditing(false);
		if (cancelled) return;
		const nextTitle = event.currentTarget.value.trim() || undefined;
		if (nextTitle === element.title) return;
		updateCalloutMetadata(editor, props.element, {
			title: event.currentTarget.value,
			typeRaw,
		});
	};

	const handleTitleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			event.currentTarget.blur();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			cancelTitleEditRef.current = true;
			event.currentTarget.blur();
		}
	};

	return (
		<PlateElement
			{...props}
			className={cn(
				"my-3 rounded-md border border-l-4 px-4 py-2.5 not-italic",
				theme.className,
			)}
		>
			{readOnly ? (
				<div
					className="flex select-none items-center gap-2 pb-1 font-semibold text-sm"
					contentEditable={false}
				>
					<theme.Icon
						className={cn("size-4 shrink-0", theme.iconClassName)}
						aria-hidden
					/>
					<span>{title}</span>
				</div>
			) : (
				<div
					className="-mx-1 flex min-w-0 items-center gap-1 pb-1"
					contentEditable={false}
				>
					<Popover open={typeOpen} onOpenChange={setTypeOpen} modal={false}>
						<PopoverTrigger asChild>
							<button
								type="button"
								className="flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50"
								aria-label={t("callout.typePickerLabel")}
							>
								<theme.Icon
									className={cn("size-4", theme.iconClassName)}
									aria-hidden
								/>
							</button>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-52 p-0">
							<Command value={type}>
								<CommandList className="max-h-[40vh]">
									<CommandGroup>
										{CALLOUT_TYPES.map((calloutType) => {
											const optionTheme = CALLOUT_THEMES[calloutType];
											const OptionIcon = optionTheme.Icon;
											return (
												<CommandItem
													key={calloutType}
													value={calloutType}
													onSelect={() => handleTypeSelect(calloutType)}
													data-checked={
														type === calloutType ? "true" : undefined
													}
												>
													<OptionIcon
														className={cn("size-4", optionTheme.iconClassName)}
														aria-hidden
													/>
													<span>{t(CALLOUT_TYPE_KEYS[calloutType])}</span>
												</CommandItem>
											);
										})}
									</CommandGroup>
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
					<input
						type="text"
						className="h-6 min-w-0 flex-1 border-0 bg-transparent px-1 font-semibold text-sm outline-none shadow-none placeholder:text-current placeholder:opacity-100 hover:bg-transparent focus:bg-transparent focus:outline-none focus:ring-0"
						value={titleEditing ? titleDraft : (element.title ?? "")}
						placeholder={title}
						aria-label={t("callout.titleInputLabel")}
						onFocus={handleTitleFocus}
						onChange={(event) => setTitleDraft(event.target.value)}
						onBlur={handleTitleBlur}
						onKeyDown={handleTitleKeyDown}
					/>
				</div>
			)}
			<div className="[&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
				{props.children}
			</div>
		</PlateElement>
	);
}
