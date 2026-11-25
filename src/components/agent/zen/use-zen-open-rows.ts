/**
 * Projection of every Zen slot's sessions for host surfaces (history rail and
 * Dockview tabs). Open session rows update on stream/session changes without
 * re-rendering on transcript line flushes.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { AgentSessionRecord } from "@/lib/agent/agent-session-store";
import type { ZenSlot } from "@/lib/agent/zen-store";

/** Open-session projection — the only signals the row list reacts to. */
export type ZenOpenRow = {
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
 * JSON signature of presentation-only fields, so stream flushes (`lines`) do
 * not re-render the list.
 */
export function useZenOpenRows(slots: ZenSlot[]): ZenOpenRow[] {
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
