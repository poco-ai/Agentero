/**
 * Review column for one TeX buffer. Threads stay out of the source file.
 */

import {
	Check,
	MessageSquarePlus,
	Reply,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import type { TexComment } from "@/lib/tex/comments";

const REVIEW_WIDTH_KEY = "agentero-tex-review-width";
const REVIEW_DEFAULT_PX = 384;
export const TEX_REVIEW_MIN_PX = 176;
export const TEX_REVIEW_MAX_PX = 560;

/** Last dragged review-column width, clamped to the sash limits. */
export function readTexReviewWidth(): number {
	const stored = readJsonStorage<number | null>(REVIEW_WIDTH_KEY, null);
	if (typeof stored !== "number" || !Number.isFinite(stored)) {
		return REVIEW_DEFAULT_PX;
	}
	return Math.min(TEX_REVIEW_MAX_PX, Math.max(TEX_REVIEW_MIN_PX, stored));
}

export function writeTexReviewWidth(px: number): void {
	if (!Number.isFinite(px)) return;
	writeJsonStorage(
		REVIEW_WIDTH_KEY,
		Math.round(Math.min(TEX_REVIEW_MAX_PX, Math.max(TEX_REVIEW_MIN_PX, px))),
	);
}

export function TexReviewPanel({
	threads,
	draft,
	activeId,
	showResolved,
	onShowResolved,
	onSubmitDraft,
	onCancelDraft,
	onReply,
	onEdit,
	onDelete,
	onResolve,
	onSelect,
	onAddToChat,
}: {
	threads: readonly TexComment[];
	draft: { quote: string } | null;
	activeId: string | null;
	showResolved: boolean;
	onShowResolved: (shown: boolean) => void;
	onSubmitDraft: (body: string) => void;
	onCancelDraft: () => void;
	onReply: (threadId: string, body: string) => void;
	onEdit: (threadId: string, messageId: string, body: string) => void;
	onDelete: (threadId: string, messageId: string) => void;
	onResolve: (threadId: string, resolved: boolean) => void;
	onSelect: (thread: TexComment) => void;
	onAddToChat: (thread: TexComment) => void;
}) {
	const { t } = useTranslation("latexLanguage");
	const visible = threads.filter((thread) => thread.resolved === showResolved);

	return (
		<aside className="@container/review flex h-full w-full min-w-0 flex-col overflow-hidden border-l border-border bg-background">
			<div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
				<span className="text-xs font-medium">{t("review")}</span>
				<Button
					type="button"
					size="xs"
					variant={showResolved ? "secondary" : "ghost"}
					aria-pressed={showResolved}
					onClick={() => onShowResolved(!showResolved)}
				>
					{t("resolvedComments")}
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
				{draft ? (
					<DraftComposer
						quote={draft.quote}
						onSubmit={onSubmitDraft}
						onCancel={onCancelDraft}
					/>
				) : null}
				{visible.length === 0 && !draft ? (
					<p className="px-1 py-6 text-center text-xs text-muted-foreground">
						{t(showResolved ? "noResolvedComments" : "noComments")}
					</p>
				) : null}
				{visible.map((thread) => (
					<ThreadCard
						key={thread.id}
						thread={thread}
						active={thread.id === activeId}
						onReply={onReply}
						onEdit={onEdit}
						onDelete={onDelete}
						onResolve={onResolve}
						onSelect={onSelect}
						onAddToChat={onAddToChat}
					/>
				))}
			</div>
		</aside>
	);
}

function DraftComposer({
	quote,
	onSubmit,
	onCancel,
}: {
	quote: string;
	onSubmit: (body: string) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("latexLanguage");
	const [body, setBody] = useState("");
	return (
		<form
			className="flex flex-col gap-2 rounded-md border border-border p-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (!body.trim()) return;
				onSubmit(body);
			}}
		>
			<Quote quote={quote} />
			<Textarea
				autoFocus
				value={body}
				rows={3}
				placeholder={t("commentPlaceholder")}
				aria-label={t("commentPlaceholder")}
				onChange={(event) => setBody(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						if (body.trim()) onSubmit(body);
					}
					if (event.key === "Escape") onCancel();
				}}
			/>
			<div className="flex justify-end gap-1">
				<Button type="button" size="xs" variant="ghost" onClick={onCancel}>
					{t("cancelComment")}
				</Button>
				<Button type="submit" size="xs" disabled={!body.trim()}>
					{t("submitComment")}
				</Button>
			</div>
		</form>
	);
}

function ThreadCard({
	thread,
	active,
	onReply,
	onEdit,
	onDelete,
	onResolve,
	onSelect,
	onAddToChat,
}: {
	thread: TexComment;
	active: boolean;
	onReply: (threadId: string, body: string) => void;
	onEdit: (threadId: string, messageId: string, body: string) => void;
	onDelete: (threadId: string, messageId: string) => void;
	onResolve: (threadId: string, resolved: boolean) => void;
	onSelect: (thread: TexComment) => void;
	onAddToChat: (thread: TexComment) => void;
}) {
	const { t } = useTranslation("latexLanguage");
	const [replying, setReplying] = useState(false);
	const [reply, setReply] = useState("");
	const skipReply = useRef(false);
	const finishReply = (next: string, save: boolean) => {
		const trimmed = next.trim();
		if (save && trimmed) onReply(thread.id, trimmed);
		setReply("");
		setReplying(false);
	};
	return (
		<article
			className={`flex min-w-0 flex-col gap-2 rounded-md border p-2 ${
				active ? "border-primary/50 bg-accent/40" : "border-border"
			}`}
		>
			<button
				type="button"
				className="text-left"
				onClick={() => onSelect(thread)}
			>
				<Quote quote={thread.detached ? t("commentRemoved") : thread.quote} />
			</button>
			{thread.messages.map((message) => (
				<MessageRow
					key={message.id}
					body={message.body}
					at={message.at}
					onEdit={(body) => onEdit(thread.id, message.id, body)}
					onDelete={() => onDelete(thread.id, message.id)}
				/>
			))}
			{replying ? (
				<Textarea
					autoFocus
					value={reply}
					rows={2}
					placeholder={t("replyPlaceholder")}
					aria-label={t("replyPlaceholder")}
					onChange={(event) => setReply(event.target.value)}
					onBlur={() => {
						if (skipReply.current) {
							skipReply.current = false;
							return;
						}
						finishReply(reply, true);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							skipReply.current = true;
							finishReply(reply, false);
						}
					}}
				/>
			) : null}
			<div className="-ml-2 flex flex-wrap gap-0.5">
				{thread.resolved || replying ? null : (
					<Button
						type="button"
						size="xs"
						variant="ghost"
						className="self-start"
						onClick={() => {
							skipReply.current = false;
							setReplying(true);
						}}
					>
						<Reply className="size-3.5" aria-hidden />
						<span className="@max-[17rem]/review:sr-only">
							{t("replyPlaceholder")}
						</span>
					</Button>
				)}
				{thread.resolved ? (
					<Button
						type="button"
						size="xs"
						variant="ghost"
						className="self-start"
						onClick={() => onResolve(thread.id, false)}
					>
						<RotateCcw className="size-3.5" aria-hidden />
						<span className="@max-[17rem]/review:sr-only">
							{t("reopenComment")}
						</span>
					</Button>
				) : (
					<Button
						type="button"
						size="xs"
						variant="ghost"
						className="self-start"
						onClick={() => onResolve(thread.id, true)}
					>
						<Check className="size-3.5" aria-hidden />
						<span className="@max-[17rem]/review:sr-only">
							{t("resolveComment")}
						</span>
					</Button>
				)}
				<Button
					type="button"
					size="xs"
					variant="ghost"
					className="self-start"
					onClick={() => onAddToChat(thread)}
				>
					<MessageSquarePlus className="size-3.5" aria-hidden />
					<span className="@max-[17rem]/review:sr-only">
						{t("addCommentToChat")}
					</span>
				</Button>
			</div>
		</article>
	);
}

function MessageRow({
	body,
	at,
	onEdit,
	onDelete,
}: {
	body: string;
	at: number;
	onEdit: (body: string) => void;
	onDelete: () => void;
}) {
	const { t } = useTranslation("latexLanguage");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(body);
	const skipSave = useRef(false);
	useEffect(() => {
		if (!editing) setDraft(body);
	}, [body, editing]);
	const finish = (next: string, save: boolean) => {
		const trimmed = next.trim();
		if (save && trimmed && trimmed !== body.trim()) onEdit(trimmed);
		setEditing(false);
	};
	const time = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(at);
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			{editing ? (
				<div className="relative">
					<Textarea
						autoFocus
						value={draft}
						rows={1}
						aria-label={t("editComment")}
						className="min-h-0 resize-none rounded-sm border-0 bg-transparent px-0 py-0 text-xs leading-5 shadow-none ring-1 ring-border ring-inset focus-visible:ring-1 focus-visible:ring-ring"
						onChange={(event) => setDraft(event.target.value)}
						onBlur={() => {
							if (skipSave.current) {
								skipSave.current = false;
								return;
							}
							finish(draft, true);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								skipSave.current = true;
								setDraft(body);
								setEditing(false);
							}
						}}
					/>
					<Button
						type="button"
						size="icon-xs"
						variant="ghost"
						className="absolute right-0.5 bottom-0.5 size-4 bg-background text-destructive hover:bg-destructive/10 hover:text-destructive"
						aria-label={t("deleteComment")}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => {
							skipSave.current = true;
							onDelete();
						}}
					>
						<Trash2 className="size-3" aria-hidden />
					</Button>
				</div>
			) : (
				<button
					type="button"
					className="rounded-sm text-left hover:bg-accent/60"
					onClick={() => {
						skipSave.current = false;
						setEditing(true);
					}}
				>
					<p className="whitespace-pre-wrap text-xs leading-5">{body}</p>
				</button>
			)}
			<span className="text-[10px] leading-none text-muted-foreground">
				{time}
			</span>
		</div>
	);
}

function Quote({ quote }: { quote: string }) {
	return (
		<p className="line-clamp-3 text-xs text-muted-foreground">
			{quote.replace(/\s+/g, " ").trim()}
		</p>
	);
}
