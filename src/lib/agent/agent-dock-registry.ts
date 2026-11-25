/**
 * Imperative bridge for the Agent workspace Dockview. App shortcuts
 * (close / cycle / focus) resolve to this handle while Agent mode is active,
 * mirroring the document dock handle.
 */

export type AgentDockHandle = {
	closeActive: () => void;
	cycleActive: (delta: 1 | -1) => void;
	cycleGroupTab: (delta: 1 | -1) => void;
};

let handle: AgentDockHandle | null = null;

export function registerAgentDock(next: AgentDockHandle | null): void {
	handle = next;
}

export function agentDock(): AgentDockHandle | null {
	return handle;
}
