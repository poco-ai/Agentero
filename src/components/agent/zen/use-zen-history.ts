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
	loadSession,
} from "@/lib/agent/api";
import { isBackgroundWorkflowHistoryTitle } from "@/lib/agent/chat-state";
import {
	applyListedHistoryTitles,
	getCachedHistoryTitle,
	getOverriddenHistoryTitle,
	isSessionIdPrefixTitle,
	rememberEmptyAcpSession,
	setCachedHistoryTitle,
	titleFromLoadedHistory,
} from "@/lib/agent/history-title-cache";
import {
	cachedHarnessHistory,
	fetchHarnessHistory,
	isHarnessHistoryFresh,
} from "@/lib/agent/session-history-cache";
import { isTauri } from "@/lib/core/tauri";
import { mapLimit } from "@/lib/core/utils";
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
const TITLE_CONCURRENCY = 2;

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
	return applyListedHistoryTitles(
		agentId,
		sessions.filter(
			(session) => !isBackgroundWorkflowHistoryTitle(session.title ?? ""),
		),
	).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function useZenHarnessHistory(
	vaultPath: string | null,
	enabled: boolean,
): ZenHarnessHistoryState {
	const [sections, setSections] = useState<ZenHarnessHistory[]>([]);
	const [loading, setLoading] = useState(false);
	const generationRef = useRef(0);
	const refreshRef = useRef<Promise<void> | null>(null);
	/** A second request arrived while a refresh was running (e.g. install). */
	const rerunRef = useRef(false);

	const refresh = useCallback((): Promise<void> => {
		if (!isTauri()) return Promise.resolve();
		if (refreshRef.current) {
			rerunRef.current = true;
			return refreshRef.current;
		}
		const generation = generationRef.current + 1;
		generationRef.current = generation;
		const isCurrent = () => generation === generationRef.current;
		const titleQueue: { agentId: string; sessionId: string }[] = [];
		let titlesLoading = 0;
		const updateSection = (
			agentId: string,
			update: (section: ZenHarnessHistory) => ZenHarnessHistory,
		) => {
			if (!isCurrent()) return;
			setSections((prev) =>
				prev.map((section) =>
					section.agent.id === agentId ? update(section) : section,
				),
			);
		};
		const drainTitles = () => {
			while (isCurrent() && titlesLoading < TITLE_CONCURRENCY) {
				const item = titleQueue.shift();
				if (!item) return;
				const { agentId, sessionId } = item;
				titlesLoading += 1;
				void (async () => {
					let title =
						getOverriddenHistoryTitle(agentId, sessionId) ??
						getCachedHistoryTitle(agentId, sessionId);
					if (!title || isSessionIdPrefixTitle(title, sessionId)) {
						const history = await loadSession({
							agentId,
							sessionId,
							vaultPath: vaultPath ?? undefined,
						});
						if (!isCurrent()) return;
						if (!history.lines.length) {
							rememberEmptyAcpSession(agentId, sessionId);
							updateSection(agentId, (section) => ({
								...section,
								sessions: section.sessions.filter(
									(row) => row.sessionId !== sessionId,
								),
							}));
							return;
						}
						title = titleFromLoadedHistory(history);
						if (!title || isSessionIdPrefixTitle(title, sessionId)) return;
						setCachedHistoryTitle(agentId, sessionId, title);
					}
					const resolved =
						getOverriddenHistoryTitle(agentId, sessionId) ?? title;
					updateSection(agentId, (section) => ({
						...section,
						sessions: section.sessions.map((row) =>
							row.sessionId === sessionId ? { ...row, title: resolved } : row,
						),
					}));
				})()
					.catch(() => undefined)
					.finally(() => {
						titlesLoading -= 1;
						drainTitles();
					});
			}
		};
		const queueTitles = (agentId: string, sessions: AcpSessionInfo[]) => {
			for (const session of sessions) {
				if (!session.title)
					titleQueue.push({ agentId, sessionId: session.sessionId });
			}
			drainTitles();
		};
		const run = (async () => {
			setLoading(true);
			try {
				const registry = await listAgents();
				if (!isCurrent()) return;
				const agents = registry.agents
					.filter((agent) => agent.available)
					.sort(byDefaultThenName(registry.defaultId));
				const initial = agents.map((agent) => {
					const cached = cachedHarnessHistory(vaultPath, agent.id);
					return {
						agent,
						sessions: cached
							? visibleSessions(agent.id, cached.sessions)
							: null,
						loading: !isHarnessHistoryFresh(cached),
					};
				});
				// Publish every harness immediately — the registry is one cheap call —
				// and let each harness fill in its own rows. The sidebar must not
				// depend on the slowest ACP start to show which agents exist.
				setSections((prev) => {
					const previous = new Map(
						prev.map((section) => [section.agent.id, section.sessions]),
					);
					return initial.map((section) => ({
						...section,
						sessions:
							section.sessions ??
							visibleSessions(
								section.agent.id,
								previous.get(section.agent.id) ?? [],
							),
					}));
				});
				for (const section of initial) {
					if (!section.loading && section.sessions)
						queueTitles(section.agent.id, section.sessions);
				}
				await mapLimit(
					initial.filter((section) => section.loading),
					LOAD_CONCURRENCY,
					async (section) => {
						if (!isCurrent()) return;
						const agentId = section.agent.id;
						const entry = await fetchHarnessHistory({
							vaultPath,
							agentId,
						}).catch(() => null);
						if (!isCurrent()) return;
						const sessions = entry
							? visibleSessions(agentId, entry.sessions)
							: section.sessions;
						updateSection(agentId, (current) => ({
							...current,
							sessions: sessions ?? current.sessions,
							loading: false,
						}));
						if (sessions) queueTitles(agentId, sessions);
					},
				);
			} catch {
				// `listAgents` failed: keep the current list.
			} finally {
				if (isCurrent()) setLoading(false);
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
	}, [vaultPath]);

	useEffect(() => {
		if (!enabled) return;
		void refresh();
		return () => {
			generationRef.current += 1;
			refreshRef.current = null;
			rerunRef.current = false;
			setSections([]);
			setLoading(false);
		};
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
