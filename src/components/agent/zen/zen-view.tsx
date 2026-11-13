/**
 * Zen — full-page multi-conversation Agent surface.
 *
 * Left: one row per conversation slot (harness, current session, status).
 * Right: the active slot's {@link AgentPanel}. Every slot stays mounted and
 * hidden while inactive so background turns keep streaming; each slot has its
 * own session store injected through `AgentSessionScopeContext`.
 *
 * Virtual tab path / slot store live in `lib/agent/zen-path.ts` and
 * `lib/agent/zen-store.ts`.
 */
import { Plus, Waves, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { AgentLogo } from "@/components/agent/agent-logo";
import { AgentPanel } from "@/components/agent/agent-panel";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
} from "@/hooks/use-app-stores";
import type { AgentSessionStore } from "@/lib/agent/agent-session-store";
import { AgentSessionScopeContext } from "@/lib/agent/agent-session-store";
import { focusAgentComposer } from "@/lib/agent/composer-focus";
import { displayHistoryTitle } from "@/lib/agent/prompt-display";
import {
	useZenStore,
	type ZenSlot,
	zenScopeId,
	zenStore,
} from "@/lib/agent/zen-store";
import { cn } from "@/lib/core/utils";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { openCitation } from "@/lib/workspace/actions";

function onOpenAgentSettings(): void {
	openSettingsWindow("agent");
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

function ZenSlotRow({
	slot,
	activeSlotId,
}: {
	slot: ZenSlot;
	activeSlotId: string | null;
}) {
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
	const active = slot.id === activeSlotId;
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

export function ZenView() {
	const { t } = useTranslation("agent");
	const slots = useZenStore((s) => s.slots);
	const activeSlotId = useZenStore((s) => s.activeSlotId);

	const newSlot = () => {
		// The new panel mounts with `autoFocus`, which focuses once committed.
		zenStore.getState().addSlot();
	};

	return (
		<section
			className="flex h-full min-h-0 w-full bg-background"
			aria-label={t("zen.title")}
		>
			<aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar/60">
				<div className="flex h-9 shrink-0 items-center justify-between pe-1.5 ps-3">
					<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						{t("zen.title")}
					</span>
					<button
						type="button"
						aria-label={t("zen.newConversation")}
						title={t("zen.newConversation")}
						className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
						onClick={newSlot}
					>
						<Plus className="size-4" />
					</button>
				</div>
				<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
					{slots.map((slot) => (
						<ZenSlotRow key={slot.id} slot={slot} activeSlotId={activeSlotId} />
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
							onClick={newSlot}
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
