import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type {
	AgentEffortEvent,
	AgentFailedEvent,
	AgentFastModeEvent,
	AgentModelsEvent,
	AgentPlanEvent,
	AgentResultPayload,
	AgentStreamEvent,
	AgentToolEvent,
	AgentUsageEvent,
} from "@/lib/agent/types";

/** Subscribe to a Host `agent:*` event, scoped to the current webview window. */
function listenAgentEvent<T>(
	event: string,
	handler: (payload: T) => void,
): Promise<UnlistenFn> {
	return getCurrentWebviewWindow().listen<T>(event, (message) =>
		handler(message.payload),
	);
}

export async function listenAgentStream(
	handler: (e: AgentStreamEvent) => void,
): Promise<UnlistenFn> {
	return listenAgentEvent("agent:stream", handler);
}

export async function listenAgentCompleted(
	handler: (e: AgentResultPayload) => void,
): Promise<UnlistenFn> {
	return listenAgentEvent("agent:completed", handler);
}

export async function listenAgentFailed(
	handler: (e: AgentFailedEvent) => void,
): Promise<UnlistenFn> {
	return listenAgentEvent("agent:failed", handler);
}

export async function listenAgentTool(
	handler: (e: AgentToolEvent) => void,
): Promise<UnlistenFn> {
	return listenAgentEvent("agent:tool", handler);
}

export async function listenAgentPlan(
	handler: (e: AgentPlanEvent) => void,
): Promise<UnlistenFn> {
	return listenAgentEvent("agent:plan", handler);
}

export async function listenAgentUsage(
	handler: (e: AgentUsageEvent) => void,
): Promise<UnlistenFn> {
	return listenAgentEvent("agent:usage", handler);
}

export async function listenAgentModels(
	handler: (e: AgentModelsEvent) => void,
): Promise<UnlistenFn> {
	return listenAgentEvent("agent:models", handler);
}

export async function listenAgentEffort(
	handler: (e: AgentEffortEvent) => void,
): Promise<UnlistenFn> {
	return listenAgentEvent("agent:effort", handler);
}

export async function listenAgentFastMode(
	handler: (e: AgentFastModeEvent) => void,
): Promise<UnlistenFn> {
	return listenAgentEvent("agent:fast-mode", handler);
}
