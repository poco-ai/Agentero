/**
 * ACP session history grouped by harness for the Zen sidebar.
 *
 * The Agent panel only lists the selected harness's sessions; Zen aggregates
 * every installed harness so a past conversation can be reopened from the
 * workspace without switching the composer first.
 */
import { useCallback, useEffect, useState } from "react";

import {
	type AcpSessionInfo,
	type AgentDescriptor,
	listAgents,
	listSessions,
} from "@/lib/agent/api";
import { isBackgroundWorkflowHistoryTitle } from "@/lib/agent/chat-state";
import { isDismissedAcpSession } from "@/lib/agent/history-title-cache";
import { isTauri } from "@/lib/core/tauri";
import { lifecycle } from "@/lib/lifecycle";

export type ZenHarnessHistory = {
	agent: AgentDescriptor;
	sessions: AcpSessionInfo[];
};

export type ZenHarnessHistoryState = {
	sections: ZenHarnessHistory[];
	loading: boolean;
	refresh: () => Promise<void>;
};

function byDefaultThenName(defaultId: string | null) {
	return (a: AgentDescriptor, b: AgentDescriptor) => {
		if (a.id === defaultId) return -1;
		if (b.id === defaultId) return 1;
		return a.name.localeCompare(b.name);
	};
}

export function useZenHarnessHistory(
	vaultPath: string | null,
	enabled: boolean,
): ZenHarnessHistoryState {
	const [sections, setSections] = useState<ZenHarnessHistory[]>([]);
	const [loading, setLoading] = useState(false);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		setLoading(true);
		try {
			const registry = await listAgents();
			const agents = registry.agents
				.filter((agent) => agent.available)
				.sort(byDefaultThenName(registry.defaultId));
			const loaded = await Promise.all(
				agents.map(async (agent) => {
					try {
						const result = await listSessions({
							agentId: agent.id,
							vaultPath: vaultPath ?? undefined,
						});
						if (!result.supported) return { agent, sessions: [] };
						const sessions = result.sessions
							.filter(
								(session) =>
									!isBackgroundWorkflowHistoryTitle(session.title ?? "") &&
									!isDismissedAcpSession(agent.id, session.sessionId),
							)
							.sort((a, b) =>
								(b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
							);
						return { agent, sessions };
					} catch {
						return { agent, sessions: [] };
					}
				}),
			);
			// Drop harnesses that neither run nor have history; the sidebar would
			// otherwise list every installed agent as an empty heading.
			setSections(loaded.filter((section) => section.sessions.length > 0));
		} catch {
			setSections([]);
		} finally {
			setLoading(false);
		}
	}, [vaultPath]);

	useEffect(() => {
		if (enabled) void refresh();
	}, [enabled, refresh]);

	useEffect(() => {
		if (!enabled) return;
		let timer: number | undefined;
		const off = lifecycle.on("agent:registry-changed", () => {
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
