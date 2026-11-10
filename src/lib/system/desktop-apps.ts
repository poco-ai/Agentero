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

/**
 * True when a resolved CLI path lives inside an installed desktop app bundle,
 * i.e. Agentero is driving the CLI that the desktop app ships instead of a
 * PATH install (`ChatGPT` → Codex, `WorkBuddy` → CodeBuddy, `QwenWork` →
 * Qoder CN, `DeepSeek Harness` → Dsh).
 *
 * macOS bundles sit under `<App>.app/Contents/Resources/…`; Windows installs
 * mirror that under `<install dir>\resources\{bin,runtime\cli\bin,…}`.
 */
export function isDesktopBundledCliPath(
	path: string | null | undefined,
): boolean {
	if (!path) return false;
	const normalized = path.replace(/\\/g, "/");
	if (normalized.includes(".app/Contents/Resources/")) return true;
	// Package-manager trees also contain `resources/bin`; they are PATH installs.
	if (/(^|\/)(node_modules|Cellar|\.local|\.npm)\//.test(normalized)) {
		return false;
	}
	return /(^|\/)resources\/(bin|runtime\/cli\/bin|codex-cli|app\.asar\.unpacked)\//.test(
		normalized,
	);
}
