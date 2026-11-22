/**
 * ACP session history grouped by harness for the Zen sidebar.
 *
 * The Agent panel only lists the selected harness's sessions; Zen aggregates
 * every installed harness so a past conversation can be reopened from the
 * workspace without switching the composer first.
 *
 * Every harness is a separate ACP process, so the list is painted from cached
 * history first and then revalidated harness by harness (bounded concurrency).
 * Waiting for all of them — the old behaviour — left the sidebar empty for as
 * long as the slowest harness needed to start.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
	type AcpSessionInfo,
	type AgentDescriptor,
	listAgents,
} from "@/lib/agent/api";
import { isBackgroundWorkflowHistoryTitle } from "@/lib/agent/chat-state";
import { isDismissedAcpSession } from "@/lib/agent/history-title-cache";
import {
	cachedHarnessHistory,
	fetchHarnessHistory,
	isHarnessHistoryFresh,
} from "@/lib/agent/session-history-cache";
import { isTauri } from "@/lib/core/tauri";
import { lifecycle } from "@/lib/lifecycle";

export type ZenHarnessHistory = {
	agent: AgentDescriptor;
	sessions: AcpSessionInfo[];
	/** The harness is known; its history query is still in flight. */
	loading: boolean;
};

export type ZenHarnessHistoryState = {
	sections: ZenHarnessHistory[];
	loading: boolean;
	refresh: () => Promise<void>;
};

/** Cold ACP starts are CPU/IO heavy; keep the fan-out small. */
const LOAD_CONCURRENCY = 3;

function byDefaultThenName(defaultId: string | null) {
	return (a: AgentDescriptor, b: AgentDescriptor) => {
		if (a.id === defaultId) return -1;
		if (b.id === defaultId) return 1;
		return a.name.localeCompare(b.name);
	};
}

/** Sidebar rows: drop internal workflow runs and sessions the user removed. */
function visibleSessions(
	agentId: string,
	sessions: AcpSessionInfo[],
): AcpSessionInfo[] {
	return sessions
		.filter(
			(session) =>
				!isBackgroundWorkflowHistoryTitle(session.title ?? "") &&
				!isDismissedAcpSession(agentId, session.sessionId),
		)
		.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** Run tasks with a fixed number of workers; stops early when one throws. */
async function runLimited<T>(
	items: T[],
	limit: number,
	task: (item: T) => Promise<void>,
): Promise<void> {
	let index = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (index < items.length) {
				const item = items[index];
				index += 1;
				await task(item);
			}
		},
	);
	await Promise.all(workers);
}

export function useZenHarnessHistory(
	vaultPath: string | null,
	enabled: boolean,
): ZenHarnessHistoryState {
	const [sections, setSections] = useState<ZenHarnessHistory[]>([]);
	const [loading, setLoading] = useState(false);
	const defaultIdRef = useRef<string | null>(null);
	/** Agents in the latest registry; late results for removed agents are dropped. */
	const knownAgentsRef = useRef<Set<string>>(new Set());
	const generationRef = useRef(0);
	const refreshRef = useRef<Promise<void> | null>(null);
	/** A second request arrived while a refresh was running (e.g. install). */
	const rerunRef = useRef(false);

	/** Replace one harness's rows (and loading flag) in place. */
	const publish = useCallback(
		(agent: AgentDescriptor, sessions: AcpSessionInfo[], loading: boolean) => {
			if (!knownAgentsRef.current.has(agent.id)) return;
			const visible = visibleSessions(agent.id, sessions);
			setSections((prev) => {
				const index = prev.findIndex(
					(section) => section.agent.id === agent.id,
				);
				const section = { agent, sessions: visible, loading };
				if (index === -1) return [...prev, section];
				const next = [...prev];
				next[index] = section;
				return next;
			});
		},
		[],
	);

	const refresh = useCallback((): Promise<void> => {
		if (!isTauri()) return Promise.resolve();
		if (refreshRef.current) {
			rerunRef.current = true;
			return refreshRef.current;
		}
		const generation = generationRef.current + 1;
		generationRef.current = generation;
		const run = (async () => {
			setLoading(true);
			try {
				const registry = await listAgents();
				if (generation !== generationRef.current) return;
				defaultIdRef.current = registry.defaultId;
				const agents = registry.agents
					.filter((agent) => agent.available)
					.sort(byDefaultThenName(registry.defaultId));
				knownAgentsRef.current = new Set(agents.map((agent) => agent.id));
				const stale = agents.filter(
					(agent) =>
						!isHarnessHistoryFresh(cachedHarnessHistory(vaultPath, agent.id)),
				);
				const staleIds = new Set(stale.map((agent) => agent.id));
				// Publish every harness immediately — the registry is one cheap call —
				// and let each harness fill in its own rows. The sidebar must not
				// depend on the slowest ACP start to show which agents exist.
				setSections((prev) => {
					const previous = new Map(
						prev.map((section) => [section.agent.id, section.sessions]),
					);
					return agents.map((agent) => ({
						agent,
						sessions: visibleSessions(
							agent.id,
							cachedHarnessHistory(vaultPath, agent.id)?.sessions ??
								previous.get(agent.id) ??
								[],
						),
						loading: staleIds.has(agent.id),
					}));
				});
				await runLimited(stale, LOAD_CONCURRENCY, async (agent) => {
					try {
						const entry = await fetchHarnessHistory({
							vaultPath,
							agentId: agent.id,
						});
						if (generation === generationRef.current) {
							publish(agent, entry.sessions, false);
						}
					} catch {
						// A harness that needs login or dies must not blank the list;
						// keep any cached rows and clear its spinner.
						if (generation === generationRef.current) {
							setSections((prev) =>
								prev.map((section) =>
									section.agent.id === agent.id
										? { ...section, loading: false }
										: section,
								),
							);
						}
					}
				});
			} catch {
				// `listAgents` failed: keep the current list.
			} finally {
				if (generation === generationRef.current) setLoading(false);
			}
		})();
		const tracked = run.finally(() => {
			if (refreshRef.current !== tracked) return;
			refreshRef.current = null;
			if (rerunRef.current) {
				rerunRef.current = false;
				void refresh();
			}
		});
		refreshRef.current = tracked;
		return tracked;
	}, [publish, vaultPath]);

	useEffect(() => {
		if (enabled) void refresh();
	}, [enabled, refresh]);

	useEffect(() => {
		if (!enabled) return;
		let timer: number | undefined;
		const off = lifecycle.on("agent:registry-changed", () => {
			// Installs/removals change which harnesses exist, not what their
			// history contains. Keep painting cached rows and refresh behind;
			// a newly installed harness has no cache entry and gets queried.
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				void refresh();
			}, 150);
		});
		return () => {
			window.clearTimeout(timer);
			off();
		};
	}, [enabled, refresh]);

	return { sections, loading, refresh };
}
