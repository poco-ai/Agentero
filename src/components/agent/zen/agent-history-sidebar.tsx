/**
 * Left rail of the Agent workspace: every ACP session grouped by harness, plus
 * the sessions currently open in Dockview tabs. Clicking a history row opens a
 * new tab; clicking an open row focuses its existing tab.
 */

import { Plus, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useZenHarnessHistory } from "@/components/agent/zen/use-zen-history";
import {
	openSessionSortTime,
	useZenOpenRows,
} from "@/components/agent/zen/use-zen-open-rows";
import {
	sessionRowIndentStyle,
	ZenHarnessSection,
} from "@/components/agent/zen/zen-session-list";
import {
	FILE_TREE_ROW_SELECTED_STATE,
	FILE_TREE_ROW_STATE,
} from "@/components/sidebar/tree-row-styles";
import { useVaultStore } from "@/hooks/use-app-stores";
import type { AcpSessionInfo } from "@/lib/agent/api";
import { focusAgentComposer } from "@/lib/agent/composer-focus";
import { focusOwnedAgentSession } from "@/lib/agent/open-owned-session";
import { displayHistoryTitle } from "@/lib/agent/prompt-display";
import { invalidateHarnessHistory } from "@/lib/agent/session-history-cache";
import { sessionHistoryItem } from "@/lib/agent/session-ref";
import { useZenStore, zenStore } from "@/lib/agent/zen-store";
import { cn } from "@/lib/core/utils";

/** One session row as the sidebar sees it (open tab or ACP history). */
type ZenSessionRow = {
	key: string;
	title: string;
	status: "running" | "failed" | null;
	sortAt: number;
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
	/** This harness's ACP history query is still running. */
	loading: boolean;
	rows: ZenSessionRow[];
};

const UNKNOWN_HARNESS = "__unknown__";

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
		<div
			className={cn(
				"group/row flex h-7 w-full items-center rounded-md pr-1",
				row.active ? FILE_TREE_ROW_SELECTED_STATE : FILE_TREE_ROW_STATE,
			)}
			style={sessionRowIndentStyle}
		>
			<button
				type="button"
				aria-current={row.active ? "true" : undefined}
				title={label}
				className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-md text-start text-sm outline-none focus-visible:ring-1 focus-visible:ring-brand"
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
						"size-1.5 shrink-0 rounded-full motion-reduce:animate-none group-hover/row:opacity-0",
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
					className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100"
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

export function AgentHistorySidebar({ active }: { active: boolean }) {
	const { t } = useTranslation("agent");
	const slots = useZenStore((s) => s.slots);
	const activeSlotId = useZenStore((s) => s.activeSlotId);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const { sections: historySections, refresh: refreshHistory } =
		useZenHarnessHistory(vaultPath, active);
	const openRows = useZenOpenRows(slots);

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
				group = { key, agentId, name, template, loading: false, rows: [] };
				map.set(key, group);
			}
			return group;
		};

		const slotById = new Map(slots.map((slot) => [slot.id, slot]));
		for (const section of historySections) {
			const group = ensure(
				section.agent.id,
				section.agent.name,
				section.agent.template,
			);
			group.loading = section.loading;
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
				sortAt: openSessionSortTime(row, historySections),
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
					sortAt: Date.parse(session.updatedAt ?? "") || 0,
					active: false,
					slotId: null,
					sessionId: null,
					history: session,
				});
			}
		}

		for (const group of map.values()) {
			group.rows.sort((left, right) => right.sortAt - left.sortAt);
		}
		// Harnesses show up as soon as the registry answers, even before their
		// sessions arrive, so the list never grows one header at a time.
		return [...map.values()];
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
		const title =
			displayHistoryTitle(session.title ?? "", "") || t("zen.untitled");
		const history = {
			id: session.sessionId,
			agentId: group.agentId,
			agentName: group.name,
			title,
			startedAt: session.updatedAt ?? "",
			providerSessionId: session.sessionId,
		};
		if (focusOwnedAgentSession(sessionHistoryItem(history))) return;
		zenStore.getState().addSlot({
			agentId: group.agentId,
			agentName: group.name,
			agentTemplate: group.template,
			history,
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
		const slot = zenStore
			.getState()
			.slots.find((candidate) => candidate.id === row.slotId);
		zenStore.getState().closeSlotSession(row.slotId, row.sessionId);
		// The harness still owns the session; re-read just this harness so the
		// row shows up under its history instead of vanishing.
		if (slot?.agent.id) {
			invalidateHarnessHistory(slot.agent.id);
			void refreshHistory();
		}
	};

	return (
		<section
			data-agent-sidebar
			className="flex h-full min-h-0 w-full flex-col bg-sidebar/60"
			aria-label={t("zen.title")}
		>
			<div className="shrink-0 px-1.5 pt-2 pb-2">
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
					<ZenHarnessSection
						key={group.key}
						name={group.name}
						template={group.template}
						loading={group.loading}
						rows={group.rows}
						onNewSlot={() => newSlotFor(group)}
						renderRow={(row) => (
							<ZenSessionRowView
								key={row.key}
								row={row}
								onActivate={() =>
									row.history
										? openHistory(group, row.history)
										: activateSession(row)
								}
								onClose={() => closeSession(row)}
							/>
						)}
					/>
				))}
			</div>
		</section>
	);
}
