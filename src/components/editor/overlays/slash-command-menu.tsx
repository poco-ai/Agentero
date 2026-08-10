"use client";

import {
	Code2,
	ExternalLink,
	Heading1,
	Heading2,
	Heading3,
	Link2,
	List,
	ListOrdered,
	ListTodo,
	type LucideIcon,
	MessageSquareWarning,
	Quote,
	Workflow,
} from "lucide-react";
import { useEditorRef } from "platejs/react";
import type { MutableRefObject } from "react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	type CompletionMenuController,
	useCompletionMenu,
} from "@/components/editor/hooks/use-completion-menu";
import { ViewportFloating } from "@/components/ui/viewport-floating";
import {
	executeSlashCommand,
	filterSlashCommands,
	isSlashCommandSubmitKey,
	type SlashCommand,
	type SlashCommandId,
} from "@/lib/markdown/slash-command";

export type SlashCommandDraft = {
	query: string;
	path: number[];
	start: number;
	end: number;
	left: number;
	top: number;
	allowCallout: boolean;
};

export type SlashCommandController = CompletionMenuController;

type SlashCommandMenuProps = {
	draft: SlashCommandDraft | null;
	onClose: () => void;
	controllerRef: MutableRefObject<SlashCommandController | null>;
	/**
	 * Called after a command successfully mutates the editor (Enter / click).
	 * Parent should suppress the following `beforeinput` insertParagraph so
	 * WebKit/Tauri does not insert a newline after slash confirm.
	 */
	onCommandExecuted?: () => void;
};

const COMMAND_ICONS: Record<SlashCommandId, LucideIcon> = {
	heading1: Heading1,
	heading2: Heading2,
	heading3: Heading3,
	bulletedList: List,
	numberedList: ListOrdered,
	todoList: ListTodo,
	quote: Quote,
	codeBlock: Code2,
	mermaid: Workflow,
	internalLink: Link2,
	externalLink: ExternalLink,
	callout: MessageSquareWarning,
};

export function SlashCommandMenu({
	draft,
	onClose,
	controllerRef,
	onCommandExecuted,
}: SlashCommandMenuProps) {
	const { t } = useTranslation("editor");
	const editor = useEditorRef();
	const commands = useMemo(
		() =>
			draft
				? filterSlashCommands(draft.query, (command) => t(command.labelKey), {
						allowCallout: draft.allowCallout,
					})
				: [],
		[draft, t],
	);
	const draftQuery = draft?.query ?? null;
	const draftAllowCallout = draft?.allowCallout ?? false;

	const selectCommand = useCallback(
		(command: SlashCommand) => {
			if (!draft) return false;
			const handled = executeSlashCommand(editor, command.id, {
				query: draft.query,
				path: draft.path,
				start: draft.start,
				end: draft.end,
			});
			if (!handled) return false;
			// Enter confirm still fires `beforeinput` insertParagraph on WebKit
			// even after keydown preventDefault — parent must suppress it.
			onCommandExecuted?.();
			onClose();
			// External link opens its own edit popover and focuses the URL field.
			// Refocusing the editor here would steal focus and close that popover.
			if (command.id !== "externalLink") {
				window.requestAnimationFrame(() => {
					editor.tf.focus({
						at: editor.selection ?? undefined,
					});
				});
			}
			return true;
		},
		[draft, editor, onClose, onCommandExecuted],
	);

	const { selectedIndex, setSelectedIndex, listRef } = useCompletionMenu({
		items: commands,
		open: Boolean(draft),
		resetKey: `${draftQuery}|${draftAllowCallout}`,
		onClose,
		controllerRef,
		onSubmitKey: (event, command) => {
			if (!command || !isSlashCommandSubmitKey(event.key)) return false;
			if (!selectCommand(command)) return false;
			event.preventDefault();
			event.stopPropagation();
			// Stop the event from reaching Slate's default Enter handler.
			if (typeof event.nativeEvent?.stopImmediatePropagation === "function") {
				event.nativeEvent.stopImmediatePropagation();
			}
			return true;
		},
	});

	if (!draft) return null;
	return (
		<ViewportFloating
			point={{ x: draft.left, y: draft.top }}
			className="z-50 w-64 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
			data-editor-completion="slash"
		>
			<div
				ref={listRef}
				className="max-h-64 overflow-y-auto p-1"
				role="listbox"
				aria-label={t("slashCommand.label")}
			>
				{commands.length ? (
					commands.map((command, index) => {
						const Icon = COMMAND_ICONS[command.id];
						return (
							<button
								key={command.id}
								type="button"
								role="option"
								tabIndex={-1}
								aria-selected={index === selectedIndex}
								className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none ${
									index === selectedIndex
										? "bg-accent text-accent-foreground"
										: "hover:bg-accent/60"
								}`}
								onMouseEnter={() => setSelectedIndex(index)}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => selectCommand(command)}
							>
								<Icon
									className="size-4 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								<span className="truncate">{t(command.labelKey)}</span>
							</button>
						);
					})
				) : (
					<p className="px-2 py-1.5 text-muted-foreground text-xs">
						{t("slashCommand.empty")}
					</p>
				)}
			</div>
		</ViewportFloating>
	);
}
