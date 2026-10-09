import {
	commands,
	type DesktopAppId,
	type DesktopAppStatus_Serialize,
} from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

export type { DesktopAppId } from "@/lib/core/bindings";
export type DesktopAppStatus = DesktopAppStatus_Serialize;

/** Display order in Settings. */
export const DESKTOP_APP_IDS: DesktopAppId[] = [
	"chatgpt",
	"qwenwork",
	"workbuddy",
	"dsh-desktop",
];

/** Detect which known desktop apps are installed on this machine. */
export function probeDesktopApps(): Promise<DesktopAppStatus[]> {
	return callApiResult(() => commands.desktopAppsProbe());
}

/** Launch one installed desktop app. */
export async function openDesktopApp(id: DesktopAppId): Promise<void> {
	await callApiResult(() => commands.desktopAppOpen(id));
}
