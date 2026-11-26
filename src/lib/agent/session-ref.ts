import type { AgentSessionRecord } from "@/lib/agent/agent-session-store";
import {
	type ChatSessionHistoryItem,
	providerSessionIdForHistoryLoad,
} from "@/lib/agent/chat-state";

export type AgentSessionRef = Pick<
	ChatSessionHistoryItem,
	"id" | "agentId" | "agentName" | "title" | "startedAt"
> & { providerSessionId: string };

export function sessionReference(
	session: AgentSessionRecord | undefined,
): AgentSessionRef | undefined {
	if (!session || session.visualTraceId || session.resumeable === false) return;
	const { id, agentId, agentName, title, startedAt } = session;
	return {
		id,
		agentId,
		agentName,
		title,
		startedAt,
		providerSessionId: providerSessionIdForHistoryLoad(session),
	};
}

export function sessionMatchesRef(
	session: ChatSessionHistoryItem,
	ref: AgentSessionRef,
): boolean {
	return (
		session.agentId === ref.agentId &&
		(session.id === ref.id ||
			providerSessionIdForHistoryLoad(session) === ref.providerSessionId)
	);
}

export function sessionHistoryItem(
	ref: AgentSessionRef,
): ChatSessionHistoryItem {
	return {
		...ref,
		source: "external",
		lines: [],
		status: "completed",
		resumeable: true,
	};
}
