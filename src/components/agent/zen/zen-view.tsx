/**
 * Zen — full-page multi-conversation Agent surface.
 *
 * Left: sessions grouped by harness — open slots plus each harness's ACP
 * history, so a past conversation can be reopened without switching the
 * composer first. Right: the active slot's {@link AgentPanel}. Every slot
 * stays mounted and hidden while inactive so background turns keep streaming;
 * each slot has its own session store injected through
 * `AgentSessionScopeContext`.
 *
 * Virtual tab path / slot store live in `lib/agent/zen-path.ts` and
 * `lib/agent/zen-store.ts`.
 */
import { Plus, RotateCw, Waves, X } from "lucide-react";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { AgentLogo } from "@/components/agent/agent-logo";
import { AgentPanel } from "@/components/agent/agent-panel";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
} from "@/hooks/use-app-stores";
import {
	AgentSessionScopeContext,
	type AgentSessionStore,
} from "@/lib/agent/agent-session-store";
import type { AcpSessionInfo } from "@/lib/agent/api";
import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import { focusAgentComposer } from "@/lib/agent/composer-focus";
import { displayHistoryTitle } from "@/lib/agent/prompt-display";
import {
	useZenStore,
	type ZenHistoryItem,
	type ZenSlot,
	zenScopeId,
	zenStore,
} from "@/lib/agent/zen-store";
import { cn } from "@/lib/core/utils";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { openCitation } from "@/lib/workspace/actions";
import { useZenHarnessHistory } from "./use-zen-history";

function onOpenAgentSettings(): void {
	openSettingsWindow("agent");
}

function historyItemFor(pending: ZenHistoryItem): ChatSessionHistoryItem {
	return {
		id: pending.id,
		agentId: pending.agentId,
		agentName: pending.agentName,
		title: pending.title,
		startedAt: pending.startedAt,
		providerSessionId: pending.providerSessionId,
		source: "external",
		lines: [],
		status: "completed",
		resumeable: true,
	};
}

function ZenSlotPanel({
	slot,
	autoFocus,
}: {
	slot: ZenSlot;
	autoFocus: boolean;
}) {
	const scope = useMemo(
		() => ({ store: slot.store, scopeId: zenScopeId(slot.id) }),
		[slot.id, slot.store],
	);
	const historyItem = useMemo(
		() => (slot.pendingHistory ? historyItemFor(slot.pendingHistory) : null),
		[slot.pendingHistory],
	);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const vaultMarkdownPaths = useVaultStore((s) => s.vaultMdFiles);
	const vaultDirectoryPaths = useVaultStore((s) => s.vaultDirPaths);
	const vaultPaperPaths = useVaultStore((s) => s.vaultPaperPaths);
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const paperTreeLabelMode = useSettings((s) => s.paperTreeLabelMode);

	return (
		<AgentSessionScopeContext.Provider value={scope}>
			<AgentPanel
				vaultPath={vaultPath}
				vaultMarkdownPaths={vaultMarkdownPaths}
				vaultDirectoryPaths={vaultDirectoryPaths}
				vaultPaperPaths={vaultPaperPaths}
				paperMetaByRelPath={paperMetaByRelPath}
				paperTreeLabelMode={paperTreeLabelMode}
				className="h-full min-h-0"
				initialAgentId={slot.agent.id}
				openHistoryItem={historyItem}
				onOpenHistoryHandled={() =>
					zenStore.getState().clearSlotHistory(slot.id)
				}
				onAgentChange={(agent) =>
					zenStore.getState().setSlotAgent(slot.id, agent)
				}
				onOpenAgentSettings={onOpenAgentSettings}
				onOpenSource={openCitation}
				autoFocus={autoFocus}
			/>
		</AgentSessionScopeContext.Provider>
	);
}

function activeSessionTitle(state: AgentSessionStore): string {
	const active = state.sessions.find(
		(session) => session.id === state.activeTabId,
	);
	return active?.title ?? "";
}

function ZenSlotRow({ slot, active }: { slot: ZenSlot; active: boolean }) {
	const { t } = useTranslation("agent");
	// Primitive selectors: streaming flushes swap `lines` (and the sessions
	// array identity) without touching these signals, so the list stays calm.
	const title = useStore(slot.store, activeSessionTitle);
	const running = useStore(slot.store, (state) =>
		state.sessions.some((session) => session.status === "running"),
	);
	const failed = useStore(
		slot.store,
		(state) =>
			state.sessions.find((session) => session.id === state.activeTabId)
				?.status === "failed",
	);
	const label = displayHistoryTitle(title, "") || t("zen.untitled");
	const status = running ? "running" : failed ? "failed" : null;

	return (
		<div className="group relative">
			<button
				type="button"
				aria-current={active ? "true" : undefined}
				className={cn(
					"flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pe-8 ps-2 text-start outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
					active
						? "bg-accent text-accent-foreground"
						: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
				)}
				onClick={() => {
					zenStore.getState().activateSlot(slot.id);
					focusAgentComposer();
				}}
			>
				<AgentLogo template={slot.agent.template} plain className="size-4" />
				<span className="min-w-0 flex-1 truncate text-sm">{label}</span>
			</button>
			{status ? (
				<span
					role="img"
					aria-label={t(`history.status.${status}`)}
					title={t(`history.status.${status}`)}
					className={cn(
						"pointer-events-none absolute top-1/2 right-2.5 size-1.5 -translate-y-1/2 rounded-full motion-reduce:animate-none group-hover:opacity-0",
						status === "running"
							? "animate-pulse bg-emerald-500"
							: "bg-destructive",
					)}
				/>
			) : null}
			<button
				type="button"
				aria-label={t("zen.close")}
				title={t("zen.close")}
				className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
				onClick={() => zenStore.getState().removeSlot(slot.id)}
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

function ZenHistoryRow({
	session,
	onOpen,
}: {
	session: AcpSessionInfo;
	onOpen: () => void;
}) {
	const { t } = useTranslation("agent");
	const label =
		displayHistoryTitle(session.title ?? "", "") || t("zen.untitled");
	return (
		<button
			type="button"
			title={label}
			className="flex w-full min-w-0 items-center rounded-md py-1 pe-2 ps-7 text-start text-muted-foreground text-xs outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
			onClick={onOpen}
		>
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</button>
	);
}

/** One harness section: its open slots first, then recent ACP sessions. */
type HarnessGroup = {
	key: string;
	agentId: string | null;
	name: string;
	template: string | null;
	slots: ZenSlot[];
	history: AcpSessionInfo[];
};

/**
 * Session ids already open in a slot (runtime + provider id). Kept as a stable
 * string signature so stream flushes do not re-render the history list.
 */
function useOpenSessionIds(slots: ZenSlot[]): ReadonlySet<string> {
	const subscribe = useCallback(
		(onChange: () => void) => {
			const unsubs = slots.map((slot) => slot.store.subscribe(onChange));
			return () => {
				for (const unsubscribe of unsubs) unsubscribe();
			};
		},
		[slots],
	);
	const getSnapshot = useCallback(() => {
		const ids: string[] = [];
		for (const slot of slots) {
			for (const session of slot.store.getState().sessions) {
				ids.push(session.id);
				if (session.providerSessionId) ids.push(session.providerSessionId);
			}
		}
		return [...new Set(ids)].sort().join("\n");
	}, [slots]);
	const signature = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	return useMemo(
		() => new Set(signature ? signature.split("\n") : []),
		[signature],
	);
}

function HarnessSection({
	group,
	activeSlotId,
	openSessionIds,
	onNewSlot,
	onOpenHistory,
}: {
	group: HarnessGroup;
	activeSlotId: string | null;
	openSessionIds: ReadonlySet<string>;
	onNewSlot: () => void;
	onOpenHistory: (session: AcpSessionInfo) => void;
}) {
	const { t } = useTranslation("agent");
	const history = group.history.filter(
		(session) => !openSessionIds.has(session.sessionId),
	);

	return (
		<section className="pb-1">
			<div className="group flex h-7 items-center gap-1.5 pe-1 ps-2">
				<AgentLogo template={group.template} plain className="size-3.5" />
				<span className="min-w-0 flex-1 truncate font-medium text-muted-foreground text-xs">
					{group.name}
				</span>
				<button
					type="button"
					aria-label={t("zen.newConversation")}
					title={t("zen.newConversation")}
					className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
					onClick={onNewSlot}
				>
					<Plus className="size-3.5" />
				</button>
			</div>
			{group.slots.map((slot) => (
				<ZenSlotRow
					key={slot.id}
					slot={slot}
					active={slot.id === activeSlotId}
				/>
			))}
			{history.map((session) => (
				<ZenHistoryRow
					key={session.sessionId}
					session={session}
					onOpen={() => onOpenHistory(session)}
				/>
			))}
		</section>
	);
}

const UNKNOWN_HARNESS = "__unknown__";

export function ZenView({ active }: { active: boolean }) {
	const { t } = useTranslation("agent");
	const slots = useZenStore((s) => s.slots);
	const activeSlotId = useZenStore((s) => s.activeSlotId);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const {
		sections: historySections,
		loading: historyLoading,
		refresh: refreshHistory,
	} = useZenHarnessHistory(vaultPath, active);
	const openSessionIds = useOpenSessionIds(slots);

	const groups = useMemo<HarnessGroup[]>(() => {
		const map = new Map<string, HarnessGroup>();
		for (const section of historySections) {
			map.set(section.agent.id, {
				key: section.agent.id,
				agentId: section.agent.id,
				name: section.agent.name,
				template: section.agent.template,
				slots: [],
				history: section.sessions,
			});
		}
		for (const slot of slots) {
			const key = slot.agent.id ?? UNKNOWN_HARNESS;
			let group = map.get(key);
			if (!group) {
				group = {
					key,
					agentId: slot.agent.id,
					name: slot.agent.name ?? t("defaultName"),
					template: slot.agent.template,
					slots: [],
					history: [],
				};
				map.set(key, group);
			}
			group.slots.push(slot);
		}
		// Empty harnesses (installed, no slots, no history) are not listed.
		return [...map.values()].filter(
			(group) => group.slots.length > 0 || group.history.length > 0,
		);
	}, [historySections, slots, t]);

	const newSlotFor = (
		agent: { id: string; name: string; template: string | null } | null,
	) => {
		zenStore.getState().addSlot(
			agent
				? {
						agentId: agent.id,
						agentName: agent.name,
						agentTemplate: agent.template,
					}
				: undefined,
		);
		focusAgentComposer();
	};

	const openHistory = (
		agentId: string,
		name: string,
		session: AcpSessionInfo,
	) => {
		const existing = zenStore
			.getState()
			.slots.find(
				(slot) =>
					slot.pendingHistory?.id === session.sessionId ||
					slot.store
						.getState()
						.sessions.some(
							(item) =>
								item.id === session.sessionId ||
								item.providerSessionId === session.sessionId,
						),
			);
		if (existing) {
			zenStore.getState().activateSlot(existing.id);
			focusAgentComposer();
			return;
		}
		const title =
			displayHistoryTitle(session.title ?? "", "") || t("zen.untitled");
		zenStore.getState().addSlot({
			agentId,
			agentName: name,
			agentTemplate:
				historySections.find((section) => section.agent.id === agentId)?.agent
					.template ?? null,
			history: {
				id: session.sessionId,
				agentId,
				agentName: name,
				title,
				startedAt: session.updatedAt ?? "",
				providerSessionId: session.sessionId,
			},
		});
		focusAgentComposer();
	};

	return (
		<section
			className="flex h-full min-h-0 w-full bg-background"
			aria-label={t("zen.title")}
		>
			<aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar/60">
				<div className="flex h-9 shrink-0 items-center justify-between pe-1.5 ps-3">
					<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						{t("zen.title")}
					</span>
					<div className="flex items-center gap-0.5">
						<button
							type="button"
							aria-label={t("zen.refreshHistory")}
							title={t("zen.refreshHistory")}
							className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
							onClick={() => void refreshHistory()}
						>
							<RotateCw
								className={cn(
									"size-3.5",
									historyLoading && "animate-spin motion-reduce:animate-none",
								)}
							/>
						</button>
						<button
							type="button"
							aria-label={t("zen.newConversation")}
							title={t("zen.newConversation")}
							className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
							onClick={() => newSlotFor(null)}
						>
							<Plus className="size-4" />
						</button>
					</div>
				</div>
				<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
					{groups.map((group) => (
						<HarnessSection
							key={group.key}
							group={group}
							activeSlotId={activeSlotId}
							openSessionIds={openSessionIds}
							onNewSlot={() =>
								newSlotFor(
									group.agentId
										? {
												id: group.agentId,
												name: group.name,
												template: group.template ?? "custom",
											}
										: null,
								)
							}
							onOpenHistory={(session) => {
								if (group.agentId) {
									openHistory(group.agentId, group.name, session);
								}
							}}
						/>
					))}
				</div>
			</aside>
			<div className="relative min-h-0 min-w-0 flex-1">
				{slots.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
						<Waves className="size-6 opacity-60" aria-hidden />
						<button
							type="button"
							className="rounded-md border border-border/70 bg-background px-3 py-1.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
							onClick={() => newSlotFor(null)}
						>
							{t("zen.newConversation")}
						</button>
					</div>
				) : (
					slots.map((slot) => (
						<div
							key={slot.id}
							className={cn(
								"h-full min-h-0",
								slot.id !== activeSlotId && "hidden",
							)}
						>
							<ZenSlotPanel slot={slot} autoFocus={slot.id === activeSlotId} />
						</div>
					))
				)}
			</div>
		</section>
	);
}
