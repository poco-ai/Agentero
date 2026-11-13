/**
 * Zen — full-page multi-conversation Agent surface.
 *
 * Left: every session grouped by harness. Open sessions sit side by side with
 * the harness's ACP history, so a past conversation can be reopened without
 * switching the composer first and opening one never closes another. Right:
 * the active slot's {@link AgentPanel}. Every slot stays mounted and hidden
 * while inactive so background turns keep streaming; each slot has its own
 * session store injected through `AgentSessionScopeContext`.
 *
 * Virtual tab path / slot store live in `lib/agent/zen-path.ts` and
 * `lib/agent/zen-store.ts`.
 */
import { ChevronRight, Plus, RotateCw, Waves, X } from "lucide-react";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import { AgentPanel } from "@/components/agent/agent-panel";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
} from "@/hooks/use-app-stores";
import {
	type AgentSessionRecord,
	AgentSessionScopeContext,
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
				wide
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

/** One session row as the sidebar sees it (open slot session or ACP history). */
type ZenSessionRow = {
	key: string;
	title: string;
	status: "running" | "failed" | null;
	/** ISO timestamp used for recency ordering; empty means "just created". */
	sortAt: string;
	active: boolean;
	/** Open session: owning slot (null for a history row). */
	slotId: string | null;
	/** Open session id; null while the slot still shows its draft. */
	sessionId: string | null;
	/** History row payload, needed to resume it in a fresh slot. */
	history?: AcpSessionInfo;
};

type HarnessGroup = {
	key: string;
	agentId: string | null;
	name: string;
	template: string | null;
	rows: ZenSessionRow[];
};

/** Open-session projection — the only signals the row list reacts to. */
type ZenOpenRow = {
	slotId: string;
	sessionId: string | null;
	providerSessionId: string | null;
	agentId: string | null;
	title: string;
	status: AgentSessionRecord["status"] | null;
	startedAt: string;
	activeTab: boolean;
	pendingId: string | null;
};

function openRowsSnapshot(slots: ZenSlot[]): ZenOpenRow[] {
	const rows: ZenOpenRow[] = [];
	for (const slot of slots) {
		const state = slot.store.getState();
		if (state.sessions.length === 0) {
			rows.push({
				slotId: slot.id,
				sessionId: null,
				providerSessionId: null,
				agentId: slot.agent.id,
				title: slot.pendingHistory?.title ?? "",
				status: null,
				startedAt: slot.pendingHistory?.startedAt ?? "",
				activeTab: true,
				pendingId: slot.pendingHistory?.id ?? null,
			});
			continue;
		}
		for (const session of state.sessions) {
			rows.push({
				slotId: slot.id,
				sessionId: session.id,
				providerSessionId: session.providerSessionId ?? null,
				agentId: session.agentId ?? slot.agent.id,
				title: session.title,
				status: session.status,
				startedAt: session.startedAt,
				activeTab: session.id === state.activeTabId,
				pendingId: null,
			});
		}
	}
	return rows;
}

/**
 * Subscribe to every slot's store and project open sessions. The snapshot is a
 * JSON signature of presentation-only fields, so stream flushes (`lines`)
 * do not re-render the list.
 */
function useOpenZenRows(slots: ZenSlot[]): ZenOpenRow[] {
	const subscribe = useCallback(
		(onChange: () => void) => {
			const unsubs = slots.map((slot) => slot.store.subscribe(onChange));
			return () => {
				for (const unsubscribe of unsubs) unsubscribe();
			};
		},
		[slots],
	);
	const getSnapshot = useCallback(
		() => JSON.stringify(openRowsSnapshot(slots)),
		[slots],
	);
	const signature = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	return useMemo(() => JSON.parse(signature) as ZenOpenRow[], [signature]);
}

function sortRows(a: ZenSessionRow, b: ZenSessionRow): number {
	if (!a.sortAt || !b.sortAt) return a.sortAt ? 1 : b.sortAt ? -1 : 0;
	return b.sortAt.localeCompare(a.sortAt);
}

function ZenSessionRowView({
	row,
	onActivate,
	onClose,
}: {
	row: ZenSessionRow;
	onActivate: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation("agent");
	const label = displayHistoryTitle(row.title, "") || t("zen.untitled");
	const open = row.slotId !== null;
	return (
		<div className="group/row relative">
			<button
				type="button"
				aria-current={row.active ? "true" : undefined}
				title={label}
				className={cn(
					"flex w-full min-w-0 items-center gap-2 rounded-lg py-1.5 ps-2.5 text-start text-sm outline-none transition-[background-color,color,box-shadow,transform] duration-150 ease-out focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.985] motion-reduce:transform-none motion-reduce:transition-colors",
					open ? "pe-8" : "pe-2.5",
					row.active
						? "bg-card font-medium text-foreground shadow-raised ring-1 ring-border/60"
						: open
							? "text-foreground/80 hover:bg-accent/70 hover:text-foreground"
							: "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
				)}
				onClick={onActivate}
			>
				<span className="min-w-0 flex-1 truncate">{label}</span>
			</button>
			{row.status ? (
				<span
					role="img"
					aria-label={t(`history.status.${row.status}`)}
					title={t(`history.status.${row.status}`)}
					className={cn(
						"pointer-events-none absolute top-1/2 right-2.5 size-1.5 -translate-y-1/2 rounded-full motion-reduce:animate-none group-hover/row:opacity-0",
						row.status === "running"
							? "animate-pulse bg-emerald-500"
							: "bg-destructive",
					)}
				/>
			) : null}
			{open ? (
				<button
					type="button"
					aria-label={t("zen.close")}
					title={t("zen.close")}
					className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
					onClick={(event) => {
						event.stopPropagation();
						onClose();
					}}
				>
					<X className="size-3.5" />
				</button>
			) : null}
		</div>
	);
}

function HarnessSection({
	group,
	collapsed,
	onToggle,
	onNewSlot,
	onActivateSession,
	onOpenHistory,
	onCloseSession,
}: {
	group: HarnessGroup;
	collapsed: boolean;
	onToggle: () => void;
	onNewSlot: () => void;
	onActivateSession: (row: ZenSessionRow) => void;
	onOpenHistory: (row: ZenSessionRow) => void;
	onCloseSession: (row: ZenSessionRow) => void;
}) {
	const { t } = useTranslation("agent");
	const running = group.rows.some((row) => row.status === "running");

	return (
		<section className="mb-1 space-y-0.5">
			<div className="group flex h-7 items-center pe-1">
				<button
					type="button"
					aria-expanded={!collapsed}
					aria-label={group.name}
					className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 ps-1 text-start outline-none transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring"
					onClick={onToggle}
				>
					<ChevronRight
						className={cn(
							"size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
							!collapsed && "rotate-90",
						)}
						aria-hidden
					/>
					<AgentLogo template={group.template} plain className="size-3.5" />
					<span className="min-w-0 flex-1 truncate font-medium text-muted-foreground text-xs">
						{group.name}
					</span>
					{collapsed && running ? (
						<span
							role="img"
							aria-label={t("history.status.running")}
							className="size-1.5 shrink-0 rounded-full bg-emerald-500 motion-reduce:animate-none"
						/>
					) : null}
				</button>
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
			{collapsed
				? null
				: group.rows.map((row) => (
						<ZenSessionRowView
							key={row.key}
							row={row}
							onActivate={() =>
								row.history ? onOpenHistory(row) : onActivateSession(row)
							}
							onClose={() => onCloseSession(row)}
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
	const openRows = useOpenZenRows(slots);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

	const groups = useMemo<HarnessGroup[]>(() => {
		const map = new Map<string, HarnessGroup>();
		const ensure = (
			agentId: string | null,
			name: string,
			template: string | null,
		) => {
			const key = agentId ?? UNKNOWN_HARNESS;
			let group = map.get(key);
			if (!group) {
				group = { key, agentId, name, template, rows: [] };
				map.set(key, group);
			}
			return group;
		};

		const slotById = new Map(slots.map((slot) => [slot.id, slot]));
		for (const section of historySections) {
			ensure(section.agent.id, section.agent.name, section.agent.template);
		}
		for (const row of openRows) {
			const slot = slotById.get(row.slotId);
			const group = ensure(
				row.agentId ?? slot?.agent.id ?? null,
				slot?.agent.name ?? t("defaultName"),
				slot?.agent.template ?? null,
			);
			group.rows.push({
				key: `open:${row.slotId}:${row.sessionId ?? "draft"}`,
				title: row.title,
				status:
					row.status === "running"
						? "running"
						: row.status === "failed"
							? "failed"
							: null,
				sortAt: row.startedAt,
				active: row.slotId === activeSlotId && row.activeTab,
				slotId: row.slotId,
				sessionId: row.sessionId,
			});
		}

		const openIds = new Set<string>();
		for (const row of openRows) {
			if (row.sessionId) openIds.add(row.sessionId);
			if (row.providerSessionId) openIds.add(row.providerSessionId);
			if (row.pendingId) openIds.add(row.pendingId);
		}
		for (const section of historySections) {
			const group = ensure(
				section.agent.id,
				section.agent.name,
				section.agent.template,
			);
			for (const session of section.sessions) {
				if (openIds.has(session.sessionId)) continue;
				group.rows.push({
					key: `history:${session.sessionId}`,
					title: session.title ?? "",
					status: null,
					sortAt: session.updatedAt ?? "",
					active: false,
					slotId: null,
					sessionId: null,
					history: session,
				});
			}
		}

		for (const group of map.values()) group.rows.sort(sortRows);
		return [...map.values()].filter((group) => group.rows.length > 0);
	}, [historySections, slots, openRows, activeSlotId, t]);

	const newSlotFor = (group: HarnessGroup | null) => {
		zenStore.getState().addSlot(
			group?.agentId
				? {
						agentId: group.agentId,
						agentName: group.name,
						agentTemplate: group.template ?? "custom",
					}
				: undefined,
		);
		focusAgentComposer();
	};

	/** Top "New Session" row targets the harness the user is currently in. */
	const activeGroup =
		groups.find((group) => group.rows.some((row) => row.active)) ??
		groups.find((group) => group.agentId) ??
		null;

	const openHistory = (group: HarnessGroup, session: AcpSessionInfo) => {
		if (!group.agentId) return;
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
			agentId: group.agentId,
			agentName: group.name,
			agentTemplate: group.template,
			history: {
				id: session.sessionId,
				agentId: group.agentId,
				agentName: group.name,
				title,
				startedAt: session.updatedAt ?? "",
				providerSessionId: session.sessionId,
			},
		});
		focusAgentComposer();
	};

	const activateSession = (row: ZenSessionRow) => {
		if (!row.slotId) return;
		zenStore.getState().activateSlot(row.slotId);
		const slot = zenStore
			.getState()
			.slots.find((candidate) => candidate.id === row.slotId);
		if (slot && row.sessionId) {
			slot.store.getState().setActiveTabId(row.sessionId);
		}
		focusAgentComposer();
	};

	const closeSession = (row: ZenSessionRow) => {
		if (!row.slotId) return;
		if (!row.sessionId) {
			zenStore.getState().removeSlot(row.slotId);
			return;
		}
		zenStore.getState().closeSlotSession(row.slotId, row.sessionId);
	};

	return (
		<section
			className="flex h-full min-h-0 w-full bg-background"
			aria-label={t("zen.title")}
		>
			<aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar/60">
				<div className="flex h-8 shrink-0 items-center justify-end pe-1.5">
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
				</div>
				<div className="px-1.5 pb-2">
					<button
						type="button"
						className="flex w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-foreground/5 py-2.5 pe-2 ps-2 text-foreground text-sm outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.985] motion-reduce:transform-none"
						onClick={() => newSlotFor(activeGroup)}
					>
						<Plus className="size-4 shrink-0" aria-hidden />
						<span className="min-w-0 truncate">{t("zen.newConversation")}</span>
					</button>
				</div>
				<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
					{groups.map((group) => (
						<HarnessSection
							key={group.key}
							group={group}
							collapsed={Boolean(collapsed[group.key])}
							onToggle={() =>
								setCollapsed((prev) => ({
									...prev,
									[group.key]: !prev[group.key],
								}))
							}
							onNewSlot={() => newSlotFor(group)}
							onActivateSession={activateSession}
							onOpenHistory={(row) => {
								if (row.history) openHistory(group, row.history);
							}}
							onCloseSession={closeSession}
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
							className="flex items-center justify-center gap-2 rounded-lg bg-foreground/5 px-4 py-2 text-foreground text-sm outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.985] motion-reduce:transform-none"
							onClick={() => newSlotFor(activeGroup)}
						>
							<Plus className="size-4 shrink-0" aria-hidden />
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
