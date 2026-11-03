import { commands, type TerminalAppStatus } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

export type { TerminalAppStatus };

/** Detect known external terminal apps installed on this machine. */
export function probeTerminalApps(): Promise<TerminalAppStatus[]> {
	return callApiResult(() => commands.terminalAppsProbe());
}
