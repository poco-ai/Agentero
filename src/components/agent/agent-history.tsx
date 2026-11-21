import { History, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	isSessionIdPrefixTitle,
	renameHistorySessionTitle,
} from "@/components/agent/hooks/use-agent-history";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useImeGuard } from "@/hooks/use-ime-guard";
import {
	useAgentSessionStore,
	useAgentSessionStoreApi,
} from "@/lib/agent/agent-session-store";
import type { AcpDeleteSessionResult } from "@/lib/agent/api";
import type { ChatLine, ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import { displayHistoryTitle } from "@/lib/agent/prompt-display";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";

function isHistoryDeleteConfirm(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		Boolean(target.closest("[data-history-delete-confirm]"))
	);
}

const HISTORY_STATUS_DOT = {
	running: "bg-primary motion-safe:animate-pulse",
	failed: "bg-destructive",
	cancelled: "bg-muted-foreground",
} as const;

/** First user line text — the fallback label for untitled sessions. */
function firstUserLineText(item: ChatSessionHistoryItem): string {
	return (
		item.lines.find(
			(line): line is Extract<ChatLine, { kind: "user" }> =>
				line.kind === "user",
		)?.text ?? ""
	);
}

function historyRowLabel(item: ChatSessionHistoryItem): string {
	const providerId = item.providerSessionId?.trim() || "";
	const storedTitle =
		isSessionIdPrefixTitle(item.title, item.id) ||
		(providerId !== "" && isSessionIdPrefixTitle(item.title, providerId))
			? ""
			: item.title;
	return displayHistoryTitle(
		storedTitle || firstUserLineText(item) || "",
		item.id.slice(0, 8),
	);
}

/**
 * Primitive fingerprint of everything the history rows render. Stream flushes
 * swap the sessions array (only `lines` change) without touching this string,
 * so the popover list skips those re-renders; create/delete/rename/status and
 * label-fallback changes still produce a new string.
 */
function sessionListFingerprint(sessions: ChatSessionHistoryItem[]): string {
	return sessions
		.map(
			(item) =>
				`${item.id}\t${item.providerSessionId ?? ""}\t${item.title}\t${item.status}\t${item.startedAt}\t${firstUserLineText(item)}`,
		)
		.join("\n");
}

export function HistorySessionList({
	sessionHistory,
	activeTabId,
	submitting,
	onOpen,
	onDelete,
}: {
	sessionHistory: ChatSessionHistoryItem[];
	activeTabId: string;
	submitting: boolean;
	onOpen: (item: ChatSessionHistoryItem) => void;
	onDelete: (item: ChatSessionHistoryItem) => Promise<AcpDeleteSessionResult>;
}) {
	const { t } = useTranslation(["agent", "common"]);
	const sessionStore = useAgentSessionStoreApi();
	const [renameTarget, setRenameTarget] =
		useState<ChatSessionHistoryItem | null>(null);
	const [renameTitle, setRenameTitle] = useState("");
	const [deleteTarget, setDeleteTarget] =
		useState<ChatSessionHistoryItem | null>(null);
	const [deleting, setDeleting] = useState(false);
	// compositionend can fire before the confirming Enter (see useImeGuard).
	const { isBlockedByIme, compositionProps } = useImeGuard();

	// Rename-dialog keystrokes re-render this component; don't relabel every row.
	const labels = useMemo(
		() => sessionHistory.map((item) => historyRowLabel(item)),
		[sessionHistory],
	);
	if (sessionHistory.length === 0) {
		return (
			<p className="px-3 py-4 text-muted-foreground text-sm leading-none">
				{t("history.empty")}
			</p>
		);
	}

	const beginRename = (item: ChatSessionHistoryItem) => {
		setRenameTarget(item);
		setRenameTitle(historyRowLabel(item));
	};

	const confirmRename = () => {
		if (!renameTarget) return;
		const next = renameHistorySessionTitle(
			renameTarget,
			renameTitle,
			sessionStore,
		);
		if (!next) return;
		setRenameTarget(null);
	};

	const confirmDelete = async () => {
		if (!deleteTarget || deleting) return;
		setDeleting(true);
		try {
			const result = await onDelete(deleteTarget);
			setDeleteTarget(null);
			if (result.agentError) {
				notifyError(t("history.deleteAgentFailed"), {
					description: result.agentError,
				});
			}
		} catch (error) {
			notifyError(errorText(error) || t("history.deleteFailed"));
		} finally {
			setDeleting(false);
		}
	};

	return (
		<>
			<div className="max-h-72 overflow-y-auto p-1.5">
				{sessionHistory.map((item, index) => {
					const isActive = item.id === activeTabId;
					const label = labels[index];
					const statusDot =
						item.status === "completed"
							? null
							: HISTORY_STATUS_DOT[item.status];
					const statusLabel = t(`history.status.${item.status}`);
					return (
						<div key={item.id} className="group relative">
							<button
								type="button"
								disabled={submitting}
								className={cn(
									"flex w-full flex-col gap-1 rounded-md py-2 pr-14 pl-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
									isActive
										? "bg-muted text-foreground"
										: "group-hover:bg-muted/70 focus-visible:bg-muted/70",
								)}
								onClick={() => onOpen(item)}
							>
								<span className="flex min-w-0 items-start gap-1.5">
									{statusDot ? (
										<span
											className="mt-1 inline-flex size-3 shrink-0 items-center justify-center"
											title={statusLabel}
										>
											<span
												role="img"
												aria-label={statusLabel}
												className={cn("size-1.5 rounded-full", statusDot)}
											/>
										</span>
									) : null}
									<span className="line-clamp-2 min-w-0 font-medium text-sm leading-snug">
										{label}
									</span>
								</span>
								<span className="text-muted-foreground text-xs leading-none">
									{item.startedAt}
								</span>
							</button>
							<div
								className={cn(
									"pointer-events-none absolute inset-y-0 right-1 z-10 my-auto flex items-center",
									"group-hover:pointer-events-auto",
									"has-[:focus-visible]:pointer-events-auto",
									"has-[[data-state=open]]:pointer-events-auto",
								)}
							>
								<button
									type="button"
									className={cn(
										// No translate: Button's active:translate-y-px would jump the icon.
										"flex size-6 items-center justify-center rounded-[min(var(--radius-md),10px)] text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
										"group-hover:opacity-100",
										"focus-visible:opacity-100",
										"disabled:pointer-events-none",
									)}
									aria-label={t("history.rename")}
									title={t("history.rename")}
									disabled={submitting || deleting}
									onClick={() => beginRename(item)}
								>
									<Pencil className="size-3" aria-hidden />
								</button>
								<Popover
									open={deleteTarget?.id === item.id}
									onOpenChange={(open) => {
										if (deleting) return;
										setDeleteTarget(open ? item : null);
									}}
								>
									<PopoverTrigger asChild>
										<button
											type="button"
											className={cn(
												"flex size-6 items-center justify-center rounded-[min(var(--radius-md),10px)] text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:opacity-100",
												"group-hover:opacity-100",
												"focus-visible:opacity-100",
												"disabled:pointer-events-none",
											)}
											aria-label={t("history.delete")}
											title={t("history.delete")}
											disabled={submitting || deleting}
										>
											<Trash2 className="size-3" aria-hidden />
										</button>
									</PopoverTrigger>
									<PopoverContent
										data-history-delete-confirm=""
										side="bottom"
										align="end"
										className="z-[70] w-44 gap-2 p-2.5"
									>
										<p className="font-medium text-sm leading-snug">
											{t("history.deleteConfirmTitle")}
										</p>
										<div className="flex justify-end gap-1">
											<Button
												type="button"
												size="xs"
												variant="ghost"
												disabled={deleting}
												onClick={() => setDeleteTarget(null)}
											>
												{t("common:cancel")}
											</Button>
											<Button
												type="button"
												size="xs"
												variant="destructive"
												disabled={deleting}
												onClick={() => void confirmDelete()}
											>
												{t("history.delete")}
											</Button>
										</div>
									</PopoverContent>
								</Popover>
							</div>
						</div>
					);
				})}
			</div>
			<Dialog
				open={renameTarget !== null}
				onOpenChange={(open) => {
					if (!open) setRenameTarget(null);
				}}
			>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>{t("history.rename")}</DialogTitle>
					</DialogHeader>
					<Input
						value={renameTitle}
						onChange={(event) => setRenameTitle(event.target.value)}
						{...compositionProps}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !isBlockedByIme(event)) {
								event.preventDefault();
								confirmRename();
							}
						}}
						autoFocus
						aria-label={t("history.renameAria")}
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setRenameTarget(null)}
						>
							{t("common:cancel")}
						</Button>
						<Button
							type="button"
							disabled={!renameTitle.trim()}
							onClick={confirmRename}
						>
							{t("common:save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/**
 * Subscribes on its own so history changes re-render only this list, not the
 * whole AgentPanel. Mounted inside the popover, so it exists only while open.
 */
function SidebarHistorySessions({
	activeTabId,
	submitting,
	onOpen,
	onDelete,
}: {
	activeTabId: string;
	submitting: boolean;
	onOpen: (item: ChatSessionHistoryItem) => void;
	onDelete: (item: ChatSessionHistoryItem) => Promise<AcpDeleteSessionResult>;
}) {
	const { t } = useTranslation("agent");
	// Subscribe to a derived primitive: every stream flush replaces the
	// sessions array (only `lines` change), which used to re-render this list
	// on each flush while the popover is open.
	const sessionStore = useAgentSessionStoreApi();
	const fingerprint = useAgentSessionStore((s) =>
		sessionListFingerprint(s.sessions),
	);
	// Snapshot is safe: any store update that changes what the rows render
	// also changes the fingerprint and re-runs this memo.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fingerprint is the re-read signal; dropping it would freeze the snapshot
	const sessionHistory = useMemo(
		() => sessionStore.getState().sessions,
		[fingerprint, sessionStore],
	);
	if (sessionHistory.length === 0) {
		return (
			<div className="px-3 py-4 text-muted-foreground text-sm leading-none">
				{t("history.empty")}
			</div>
		);
	}
	return (
		<HistorySessionList
			sessionHistory={sessionHistory}
			activeTabId={activeTabId}
			submitting={submitting}
			onOpen={onOpen}
			onDelete={onDelete}
		/>
	);
}

/** Sidebar-mode header: new chat + history popover (+ optional actions). */
export function SidebarHistoryTrailing({
	historyOpen,
	onHistoryOpenChange,
	activeTabId,
	submitting,
	headerActions,
	onNewConversation,
	onOpenSession,
	onDeleteSession,
}: {
	historyOpen: boolean;
	onHistoryOpenChange: (open: boolean) => void;
	activeTabId: string;
	submitting: boolean;
	headerActions?: ReactNode;
	onNewConversation: () => void;
	onOpenSession: (item: ChatSessionHistoryItem) => void;
	onDeleteSession: (
		item: ChatSessionHistoryItem,
	) => Promise<AcpDeleteSessionResult>;
}) {
	const { t } = useTranslation("agent");

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				aria-label={t("tabs.new")}
				title={t("tabs.new")}
				disabled={submitting}
				onClick={onNewConversation}
			>
				<Plus className="size-4" />
			</Button>
			<Popover open={historyOpen} onOpenChange={onHistoryOpenChange}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 gap-1 px-1.5 font-normal text-muted-foreground text-sm leading-none hover:text-foreground"
						aria-label={t("history.aria")}
						title={t("history.label")}
						disabled={submitting}
					>
						<History className="size-3.5" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="end"
					className="w-80 gap-0 p-0"
					onInteractOutside={(event) => {
						if (isHistoryDeleteConfirm(event.target)) event.preventDefault();
					}}
					onFocusOutside={(event) => {
						if (isHistoryDeleteConfirm(event.target)) event.preventDefault();
					}}
				>
					<PopoverHeader className="border-b px-3 py-2">
						<PopoverTitle className="font-medium text-sm leading-none">
							{t("history.title")}
						</PopoverTitle>
						<PopoverDescription className="text-muted-foreground text-sm leading-snug">
							{t("history.description")}
						</PopoverDescription>
					</PopoverHeader>
					<SidebarHistorySessions
						activeTabId={activeTabId}
						submitting={submitting}
						onOpen={onOpenSession}
						onDelete={onDeleteSession}
					/>
				</PopoverContent>
			</Popover>
			{headerActions}
		</>
	);
}
