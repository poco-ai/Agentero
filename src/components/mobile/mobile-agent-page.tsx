import type { TFunction } from "i18next";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	PromptInput,
	PromptInputBody,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/agent/composer/prompt-input";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/agent/conversation";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/agent/message";
import { useMobileAgentChat } from "@/components/mobile/hooks/use-mobile-agent-chat";
import type {
	AcpListSessionsResult,
	AgentLine,
	AgentPermissionRequest,
	AgentStatusEvent,
	AgentTurnPhase,
} from "@/components/mobile/types";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	MessageScrollerContent,
	MessageScrollerItem,
} from "@/components/ui/message-scroller";
import { Shimmer } from "@/components/ui/shimmer";
import { displayHistoryTitle } from "@/lib/agent/prompt-display";
import { bridgeRpc } from "@/lib/bridge/client";
import { cn } from "@/lib/core/utils";

const phaseLabelKey: Record<
	AgentTurnPhase,
	"agent.starting" | "agent.waitingModel" | "agent.reconnecting"
> = {
	starting: "agent.starting",
	"waiting-model": "agent.waitingModel",
	reconnecting: "agent.reconnecting",
};

/** Backend loading phase → status text; null falls back to the thinking label. */
function phaseStatusLabel(
	phase: AgentStatusEvent | null,
	t: TFunction<"mobile", undefined>,
): string | null {
	if (!phase) return null;
	const base = t(phaseLabelKey[phase.phase]);
	const detail = phase.detail?.trim();
	return detail ? `${base} ${detail}` : base;
}

export function MobileAgentPage({
	selectedAgentId,
	sessionId,
	onSessionId,
	historyOpen,
	onHistoryOpenChange,
}: {
	selectedAgentId: string | null;
	sessionId: string | null;
	onSessionId: (sessionId: string) => void;
	historyOpen: boolean;
	onHistoryOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("mobile");
	const {
		lines,
		sending,
		restoring,
		permission,
		phase,
		restore,
		send,
		respondToPermission,
	} = useMobileAgentChat({
		agentId: selectedAgentId,
		sessionId,
		onSessionId,
	});
	const streamingAssistant = [...lines]
		.reverse()
		.find((line) => line.role === "assistant" && line.streaming);
	const pendingLabel = phaseStatusLabel(phase, t);

	return (
		<>
			<section className="flex h-full min-h-0 flex-col">
				<Conversation className="min-h-0 flex-1">
					<ConversationContent className="gap-5 px-4 py-5 md:px-6">
						<MessageScrollerContent className="gap-5">
							{restoring ? (
								<MessageScrollerItem messageId="restoring">
									<p className="mb-3 flex items-center gap-2 text-muted-foreground text-sm">
										<LoaderCircle className="size-4 animate-spin" />
										{t("agent.restoring")}
									</p>
								</MessageScrollerItem>
							) : null}
							{lines.length === 0 && !restoring ? (
								<MessageScrollerItem messageId="empty">
									<ConversationEmptyState
										className="min-h-0 flex-1 p-4 text-base"
										title={t("agent.empty")}
									/>
								</MessageScrollerItem>
							) : (
								<>
									{lines.map((line) => (
										<MessageScrollerItem key={line.id} messageId={line.id}>
											<MobileChatLine
												line={line}
												label={
													line === streamingAssistant ? pendingLabel : null
												}
											/>
										</MessageScrollerItem>
									))}
									{sending && !streamingAssistant ? (
										<MessageScrollerItem messageId="pending">
											<Message from="assistant" className="max-w-full">
												<MessageContent className="text-base leading-6">
													<Shimmer className="text-sm">
														{pendingLabel ?? t("agent.thinking")}
													</Shimmer>
												</MessageContent>
											</Message>
										</MessageScrollerItem>
									) : null}
								</>
							)}
						</MessageScrollerContent>
					</ConversationContent>
					<ConversationScrollButton className="bottom-3 size-8 shadow-raised" />
				</Conversation>
				<PromptInput
					className="shrink-0 rounded-none border-0 border-t bg-muted/10 p-3.5 shadow-none md:px-6"
					inputGroupClassName="overflow-visible"
					onSubmit={({ text: value }) => void send(value)}
				>
					<PromptInputBody>
						<div className="flex w-full items-center gap-1 rounded-xl border bg-background px-1.5 py-0.5">
							<PromptInputTextarea
								placeholder={t("agent.placeholder")}
								disabled={sending}
								rows={1}
								className="min-h-10 max-h-32 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-base shadow-none focus-visible:ring-0 md:text-base"
							/>
							<PromptInputSubmit
								status={sending ? "submitted" : "ready"}
								disabled={sending}
								className="shrink-0"
							/>
						</div>
					</PromptInputBody>
				</PromptInput>
			</section>
			<MobilePermissionDialog
				permission={permission}
				onRespond={respondToPermission}
			/>
			<MobileAgentHistoryDialog
				open={historyOpen}
				agentId={selectedAgentId}
				onClose={() => onHistoryOpenChange(false)}
				onPick={(target) => {
					onHistoryOpenChange(false);
					void restore(target);
				}}
			/>
		</>
	);
}

function MobileChatLine({
	line,
	label = null,
}: {
	line: AgentLine;
	/** Phase-aware status text for the streaming placeholder. */
	label?: string | null;
}) {
	const { t } = useTranslation("mobile");
	const showThinking =
		line.role === "assistant" && !line.text.trim() && line.streaming;
	return (
		<Message
			from={line.role}
			className={line.role === "assistant" ? "max-w-full" : undefined}
		>
			<MessageContent
				className={cn(
					"text-base leading-6",
					line.role === "user" && "rounded-lg bg-muted px-3 py-2.5",
					line.role === "assistant" && "w-full max-w-full",
				)}
			>
				{showThinking ? (
					<Shimmer className="text-sm">{label ?? t("agent.thinking")}</Shimmer>
				) : (
					<MessageResponse
						isAnimating={line.streaming}
						enableOpenUiBlocks={line.role === "assistant"}
					>
						{line.text}
					</MessageResponse>
				)}
			</MessageContent>
		</Message>
	);
}

function MobileAgentHistoryDialog({
	open,
	agentId,
	onClose,
	onPick,
}: {
	open: boolean;
	agentId: string | null;
	onClose: () => void;
	onPick: (sessionId: string) => void;
}) {
	const { t } = useTranslation("mobile");
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<AcpListSessionsResult | null>(null);

	useEffect(() => {
		if (!open) return;
		let active = true;
		setLoading(true);
		setResult(null);
		void bridgeRpc<AcpListSessionsResult>("agent_list_sessions", {
			agentId: agentId ?? undefined,
		})
			.then((next) => active && setResult(next))
			.catch(() => active && setResult({ sessions: [], supported: false }))
			.finally(() => active && setLoading(false));
		return () => {
			active = false;
		};
	}, [agentId, open]);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="max-w-md rounded-lg">
				<DialogHeader>
					<DialogTitle>{t("agent.history")}</DialogTitle>
				</DialogHeader>
				{loading ? (
					<div className="grid place-items-center py-6">
						<LoaderCircle className="size-5 animate-spin text-muted-foreground" />
					</div>
				) : result && !result.supported ? (
					<p className="py-2 text-muted-foreground text-sm">
						{t("agent.historyUnsupported")}
					</p>
				) : result && result.sessions.length === 0 ? (
					<p className="py-2 text-muted-foreground text-sm">
						{t("agent.historyEmpty")}
					</p>
				) : (
					<ul className="agentero-scroll max-h-80 divide-y">
						{result?.sessions.map((session) => (
							<li key={session.sessionId}>
								<button
									type="button"
									className="flex w-full flex-col gap-0.5 px-1 py-3 text-left"
									onClick={() => onPick(session.sessionId)}
								>
									<span className="line-clamp-2 text-sm">
										{displayHistoryTitle(
											session.title ?? "",
											session.sessionId.slice(0, 8),
										)}
									</span>
									{session.updatedAt ? (
										<span className="text-muted-foreground text-xs">
											{session.updatedAt}
										</span>
									) : null}
								</button>
							</li>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}

function MobilePermissionDialog({
	permission,
	onRespond,
}: {
	permission: AgentPermissionRequest | null;
	onRespond: (optionId: string | null) => void;
}) {
	const { t } = useTranslation("agent");
	return (
		<Dialog
			open={permission !== null}
			onOpenChange={(open) => {
				if (!open) onRespond(null);
			}}
		>
			<DialogContent showCloseButton={false} className="max-w-md rounded-lg">
				{permission ? (
					<>
						<DialogHeader>
							<DialogTitle>{t("permission.title")}</DialogTitle>
							<DialogDescription>{permission.title}</DialogDescription>
						</DialogHeader>
						{permission.host ? (
							<p className="text-xs text-muted-foreground">
								{t("permission.remoteHost", { host: permission.host })}
							</p>
						) : null}
						{permission.paths.length ? (
							<div className="space-y-1">
								{permission.paths.map((path) => (
									<code
										key={path}
										className="block truncate bg-muted px-2 py-1 text-xs"
										title={path}
									>
										{path}
									</code>
								))}
							</div>
						) : null}
						<DialogFooter className="sm:flex-col">
							{permission.options.map((option) => (
								<Button
									key={option.optionId}
									variant={
										option.kind.startsWith("allow") ? "default" : "outline"
									}
									onClick={() => onRespond(option.optionId)}
								>
									{option.name || option.kind}
								</Button>
							))}
							<Button variant="ghost" onClick={() => onRespond(null)}>
								{t("permission.deny")}
							</Button>
						</DialogFooter>
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
