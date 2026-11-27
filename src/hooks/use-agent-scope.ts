/**
 * Mount a scope from the agent store registry and release it on unmount.
 * The store itself outlives a cross-dock re-mount by a short grace period,
 * so moving a conversation between the rail and the main workspace keeps its
 * transcript and running turn.
 */

import { useEffect } from "react";
import {
	agentScopeFor,
	releaseAgentScope,
	retainAgentScope,
} from "@/lib/agent/agent-scope-registry";
import type { AgentSessionScope } from "@/lib/agent/agent-session-store";

export function useAgentScope(scopeId: string | null): AgentSessionScope {
	const scope = agentScopeFor(scopeId);
	useEffect(() => {
		retainAgentScope(scopeId);
		return () => releaseAgentScope(scopeId);
	}, [scopeId]);
	return scope;
}
