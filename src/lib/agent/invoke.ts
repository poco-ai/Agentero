import { isTauri } from "@/lib/tauri";

/** Invoke an `agent_*` Host command; throws in non-Tauri (browser) builds. */
export async function invokeApi<T>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T> {
	if (!isTauri()) {
		throw new Error("Agent features require the Tauri desktop app.");
	}
	const { ipc } = await import("@/lib/ipc");
	return ipc<T>(cmd, args);
}
