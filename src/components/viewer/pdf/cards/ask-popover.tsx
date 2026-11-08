import {
	Maximize2Icon,
	MessageSquareIcon,
	Minimize2Icon,
	MinusIcon,
	Pencil,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	PromptInput,
	PromptInputBody,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/agent/composer/prompt-input";
import { ContextSourceLinks } from "@/components/agent/context-source-links";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
	MessageResponse,
} from "@/components/agent/message";
import {
	ChatGPTIcon,
	ClaudeIcon,
	openInChatGPT,
	openInClaude,
} from "@/components/agent/open-in-chat";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ui/shimmer";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { cn } from "@/lib/core/utils";
import { threadTitle } from "@/lib/pdf/ask/schema";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import {
	findLastUserMessageIndex,
	shouldRecallPreviousPrompt,
} from "@/lib/ui/prompt-recall";

type AskPopoverProps = {
	thread: PdfAskThread;
	/** Catalog title used to build the external "open in chat" query. */
	paperTitle?: string;
	/** Catalog arXiv / source link used in the external "open in chat" query. */
	paperLink?: string;
	screen: ScreenPoint;
	/** Match gutter pin side so the card stays next to the pin. */
	preferRight?: boolean;
	streaming: boolean;
	error: string | null;
	/** Prefill single-line prompt (e.g. page number on double-click) */
	initialPrompt?: string;
	onSend: (question: string) => void;
	/**
	 * Edit-and-resend: drop `messageId` and everything after it, then send
	 * `question` as a new turn (same rollback semantics as Agent chat).
	 */
	onResend?: (messageId: string, question: string) => void;
	/** Collapse dialog; keep margin pin */
	onHide: () => void;
	/** Remove thread + pin permanently */
	onDelete: () => void;
	onStop?: () => void;
	/** Cancel delayed hover-hide while pointer is over dialog */
	onPointerEnter?: () => void;
	/** Schedule delayed hide when leaving dialog */
	onPointerLeave?: () => void;
};

export function AskPopover({
	thread,
	paperTitle,
	paperLink,
	screen,
	preferRight = true,
	streaming,
	error,
	initialPrompt,
	onSend,
	onResend,
	onHide,
	onDelete,
	onStop,
	onPointerEnter,
	onPointerLeave,
}: AskPopoverProps) {
	const { t } = useTranslation("viewer");
	const title = threadTitle(thread, t("pdfAsk.newTitle"));
	const [expanded, setExpanded] = useState(false);
	const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
	const [editingText, setEditingText] = useState("");
	const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const scrollPortRef = useRef<HTMLDivElement | null>(null);
	const scrolledForThreadRef = useRef<string | null>(null);
	const {
		isBlockedByIme: isEditBlockedByIme,
		compositionProps: editCompositionProps,
	} = useImeGuard();

	/** Keep the first user turn in view on open — do not stick to the answer bottom. */
	const userAnchorId = useMemo(() => {
		const firstUser = thread.messages.find((m) => m.role === "user");
		return firstUser?.id ?? thread.messages[0]?.id ?? null;
	}, [thread.messages]);

	/** External AI query: explain prompt + paper title/link + page + quote. */
	const openInQuery = useMemo(() => {
		const quote = thread.anchor.quote?.trim();
		const lines: string[] = [t("pdfAsk.openInPrompt"), ""];
		if (paperTitle?.trim()) lines.push(`Paper: ${paperTitle.trim()}`);
		if (paperLink?.trim()) lines.push(`Link: ${paperLink.trim()}`);
		// Page only when the anchor has PDF geometry (plaza / feed asks have none).
		if (thread.anchor.rects.length > 0) {
			lines.push(`Page: ${thread.anchor.page}`);
		}
		if (quote) lines.push(`"${quote}"`);
		return lines.join("\n");
	}, [
		t,
		paperTitle,
		paperLink,
		thread.anchor.page,
		thread.anchor.quote,
		thread.anchor.rects.length,
	]);

	// Leave edit mode when the thread changes or a run starts.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset edit UI when identity/run changes
	useEffect(() => {
		setEditingMessageId(null);
		setEditingText("");
	}, [thread.id, streaming]);

	// Pin / hover open: place the user message once (never jump to reply end).
	useEffect(() => {
		if (scrolledForThreadRef.current === thread.id) return;
		if (!userAnchorId) return;
		const port = scrollPortRef.current;
		const el = document.getElementById(`pdf-ask-msg-${userAnchorId}`);
		if (!port || !el) return;
		scrolledForThreadRef.current = thread.id;
		requestAnimationFrame(() => {
			const portTop = port.getBoundingClientRect().top;
			const elTop = el.getBoundingClientRect().top;
			// Align user turn near the top of the scrollport.
			port.scrollTop += elTop - portTop - 8;
		});
	}, [thread.id, userAnchorId]);

	useEffect(() => {
		if (!editingMessageId) return;
		const el = editTextareaRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, [editingMessageId]);

	const startEditing = (messageId: string, text: string) => {
		if (streaming || !onResend) return;
		setEditingMessageId(messageId);
		setEditingText(text);
	};

	const cancelEditing = () => {
		setEditingMessageId(null);
		setEditingText("");
	};

	const commitResend = (messageId: string) => {
		const q = editingText.trim();
		if (!q || streaming || !onResend) return;
		setEditingMessageId(null);
		setEditingText("");
		onResend(messageId, q);
	};

	const recallLastUserPrompt = () => {
		if (streaming || !onResend) return false;
		const index = findLastUserMessageIndex(thread.messages);
		if (index < 0) return false;
		const msg = thread.messages[index];
		if (msg.role !== "user" || !msg.content.trim()) return false;
		startEditing(msg.id, msg.content);
		return true;
	};

	return (
		<SelectionCard
			screen={screen}
			width={expanded ? 720 : 360}
			height={expanded ? 600 : 360}
			// Conversation UI stays at the app's body type scale, like the
			// other floating selection cards.
			// Fixed height so the nested scrollport has a definite viewport.
			lockHeight
			resizable
			preferRight={preferRight}
			title={title}
			icon={<MessageSquareIcon />}
			ariaLabel={t("pdfAsk.dialogLabel")}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			// Body only constrains flex; messages own their own scrollport.
			bodyClassName="min-h-0 overflow-hidden p-0"
			actions={[
				{
					id: "resize",
					label: t(expanded ? "pdfAsk.restoreSize" : "pdfAsk.expand"),
					onClick: () => setExpanded((value) => !value),
					icon: expanded ? (
						<Minimize2Icon className="size-3.5" />
					) : (
						<Maximize2Icon className="size-3.5" />
					),
				},
				{
					label: t("pdfAsk.openInChatGPT"),
					onClick: () => openInChatGPT(openInQuery),
					icon: <ChatGPTIcon className="size-3.5" />,
				},
				{
					label: t("pdfAsk.openInClaude"),
					onClick: () => openInClaude(openInQuery),
					icon: <ClaudeIcon className="size-3.5" />,
				},
				{
					label: t("pdfAsk.delete"),
					onClick: onDelete,
					icon: <Trash2Icon className="size-3.5" />,
					destructive: true,
				},
				{
					label: t("pdfAsk.hide"),
					onClick: onHide,
					icon: <MinusIcon className="size-3.5" />,
				},
			]}
			footer={
				<PromptInput
					key={`${thread.id}-${initialPrompt ?? ""}`}
					className="w-full rounded-full border-border/80 bg-background shadow-none"
					inputGroupClassName="overflow-visible"
					onSubmit={({ text }) => {
						const q = text.trim();
						if (streaming || !q || editingMessageId) return;
						onSend(q);
					}}
				>
					<PromptInputBody>
						<div className="flex w-full items-center gap-1 px-1.5 py-0.5">
							<PromptInputTextarea
								placeholder={t("pdfAsk.placeholder")}
								defaultValue={initialPrompt}
								disabled={streaming || Boolean(editingMessageId)}
								rows={1}
								className="min-h-8 max-h-8 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm leading-5 shadow-none focus-visible:ring-0"
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										e.preventDefault();
										onHide();
										return;
									}
									// Empty input + ↑ → edit last user prompt (same as Agent chat).
									if (
										shouldRecallPreviousPrompt(e, e.currentTarget) &&
										recallLastUserPrompt()
									) {
										e.preventDefault();
									}
								}}
							/>
							<PromptInputSubmit
								className="shrink-0 rounded-full"
								size="icon-xs"
								status={streaming ? "streaming" : "ready"}
								onStop={streaming ? onStop : undefined}
							/>
						</div>
					</PromptInputBody>
				</PromptInput>
			}
		>
			{/* Plain scroll — not StickToBottom (hover/open must not jump to reply end). */}
			<div
				ref={scrollPortRef}
				className={cn(
					"agentero-scroll h-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto",
					"[scrollbar-gutter:stable]",
				)}
				role="log"
			>
				<div className="flex flex-col gap-3 px-3 py-2.5">
					{thread.messages.map((m) => {
						if (m.role === "system") {
							return (
								<p
									key={m.id}
									id={`pdf-ask-msg-${m.id}`}
									className="text-center text-muted-foreground text-xs"
								>
									{m.content}
								</p>
							);
						}
						const from = m.role === "user" ? "user" : "assistant";
						const isEmptyAssistant =
							from === "assistant" && !m.content.trim() && streaming;

						if (from === "user" && editingMessageId === m.id) {
							return (
								<Message
									key={m.id}
									id={`pdf-ask-msg-${m.id}`}
									from="user"
									className="max-w-full"
								>
									<div className="ml-auto flex w-full flex-col gap-2 rounded-lg bg-black/5 px-3 py-2 ring-1 ring-black/10 dark:bg-white/10 dark:ring-white/15">
										<textarea
											ref={editTextareaRef}
											className="max-h-28 min-h-12 w-full resize-none overflow-y-auto bg-transparent text-foreground text-sm leading-5 outline-none"
											value={editingText}
											onChange={(event) =>
												setEditingText(event.currentTarget.value)
											}
											{...editCompositionProps}
											onKeyDown={(event) => {
												if (event.key === "Escape") {
													event.preventDefault();
													cancelEditing();
												} else if (
													event.key === "Enter" &&
													!event.shiftKey &&
													!isEditBlockedByIme(event)
												) {
													event.preventDefault();
													commitResend(m.id);
												}
											}}
										/>
										<div className="flex items-center justify-end gap-1.5">
											<Button
												type="button"
												variant="ghost"
												size="sm"
												className="h-7 px-2 text-xs"
												onClick={cancelEditing}
											>
												{t("pdfAsk.editCancel")}
											</Button>
											<Button
												type="button"
												size="sm"
												className="h-7 px-2 text-xs"
												disabled={!editingText.trim() || streaming}
												onClick={() => commitResend(m.id)}
											>
												{t("pdfAsk.editResend")}
											</Button>
										</div>
									</div>
								</Message>
							);
						}

						return (
							<Message
								key={m.id}
								id={`pdf-ask-msg-${m.id}`}
								from={from}
								className="max-w-full"
							>
								<MessageContent
									className={cn(
										"text-sm",
										from === "user" && "px-3 py-2",
										from === "assistant" && "w-full max-w-full",
									)}
								>
									{isEmptyAssistant ? (
										<Shimmer className="text-sm" as="p">
											{t("pdfAsk.thinking")}
										</Shimmer>
									) : m.content.trim() ? (
										// Avoid live markdown reflow thrash while streaming;
										// animate only the latest assistant turn.
										<MessageResponse
											className="[&_.katex]:inline-block [&_.katex]:max-w-full [&_.katex]:overflow-x-auto [&_.katex]:overflow-y-hidden [&_.katex]:align-middle"
											isAnimating={
												streaming &&
												from === "assistant" &&
												m.id === thread.messages[thread.messages.length - 1]?.id
											}
										>
											{m.content}
										</MessageResponse>
									) : null}
									{from === "assistant" && m.sources?.length ? (
										<ContextSourceLinks
											sources={m.sources.flatMap((source) =>
												source.uri ? [source.uri] : [],
											)}
										/>
									) : null}
								</MessageContent>
								{from === "user" && onResend && !streaming ? (
									<MessageActions className="-mt-0.5 ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
										<MessageAction
											tooltip={t("pdfAsk.editAction")}
											label={t("pdfAsk.editAction")}
											onClick={() => startEditing(m.id, m.content)}
										>
											<Pencil className="size-3.5" />
										</MessageAction>
									</MessageActions>
								) : null}
							</Message>
						);
					})}
					{error ? (
						<p className="text-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
				</div>
			</div>
		</SelectionCard>
	);
}
