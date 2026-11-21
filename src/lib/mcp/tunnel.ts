/**
 * Built-in ChatGPT Secure MCP Tunnel control.
 */

import { commands } from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

export type McpTunnelPhase =
	| "binaryMissing"
	| "stopped"
	| "starting"
	| "ready"
	| "error";

export type McpTunnelStatus = {
	phase: McpTunnelPhase;
	running: boolean;
	pid: number | null;
	mcpUrl: string | null;
	installCommand: string;
	lastError: string | null;
};

const idle = (): McpTunnelStatus => ({
	phase: "stopped",
	running: false,
	pid: null,
	mcpUrl: null,
	installCommand: "brew install openai/tools/tunnel-client",
	lastError: null,
});

export async function mcpTunnelStatus(): Promise<McpTunnelStatus> {
	if (!isTauri()) return idle();
	return callApi(() => commands.mcpTunnelStatus());
}

export async function mcpTunnelStart(mcpUrl: string): Promise<McpTunnelStatus> {
	if (!isTauri()) return idle();
	return callApiResult(() => commands.mcpTunnelStart({ mcpUrl }));
}

export async function mcpTunnelStop(): Promise<McpTunnelStatus> {
	if (!isTauri()) return idle();
	return callApi(() => commands.mcpTunnelStop());
}
