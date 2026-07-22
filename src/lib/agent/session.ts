import { invokeApi } from "@/lib/agent/invoke";
import type {
	AcpListSessionsResult,
	AcpLoadSessionResult,
	PromptImage,
	RunOnceAccepted,
	WarmResult,
} from "@/lib/agent/types";
import { loadSettings } from "@/stores/settings-store";

export async function runOnce(request: {
	agentId?: string;
	/** Durable provider conversation id; Codex uses its native thread id. */
	sessionId?: string;
	prompt: string;
	/** Multimodal crops for ACP Image content blocks */
	images?: PromptImage[];
	vaultPath?: string;
	workflow?: string;
	target?: string;
	/** ACP model config value id (from agent:models). */
	modelId?: string;
	/** ACP reasoning-effort value id (from agent:effort). */
	reasoningEffort?: string;
	/** ACP fast-mode preference (from agent:fast-mode). */
	fastMode?: boolean;
	/** Local SKILL.md identifiers selected through the composer. */
	skillIds?: string[];
	/** Select the agent's first ACP permission option for this run. */
	autoApprove?: boolean;
	/** ACP permission handling: "restricted" | "ask" | "auto" (from settings). */
	permissionMode?: string;
	/**
	 * Force the language of the agent response and any generated notes.
	 * When omitted, runOnce falls back to the global `aiResponseLanguage`
	 * setting; `"auto"` (or omitting) sends no directive.
	 */
	responseLanguage?: string;
	/**
	 * User preference instructions injected into the prompt envelope.
	 * When omitted, runOnce falls back to `agentPersonalPrompt` settings;
	 * empty / whitespace-only is not sent.
	 */
	personalPrompt?: string;
	/**
	 * When true, Codex thread is not indexed into Agent chat history
	 * (paper-reader and other non-composer workflows).
	 */
	hideFromChatHistory?: boolean;
}): Promise<RunOnceAccepted> {
	const settings = loadSettings();
	const language = request.responseLanguage ?? settings.aiResponseLanguage;
	const responseLanguage =
		language && language !== "auto" ? language : undefined;
	const personalRaw = request.personalPrompt ?? settings.agentPersonalPrompt;
	const personalPrompt = personalRaw?.trim() ? personalRaw.trim() : undefined;
	return invokeApi("agent_run_once", {
		request: {
			agentId: request.agentId,
			sessionId: request.sessionId,
			prompt: request.prompt,
			images: request.images ?? [],
			vaultPath: request.vaultPath,
			workflow: request.workflow,
			target: request.target,
			modelId: request.modelId,
			reasoningEffort: request.reasoningEffort,
			fastMode: request.fastMode,
			skillIds: request.skillIds ?? [],
			autoApprove: request.autoApprove ?? false,
			permissionMode: request.permissionMode,
			responseLanguage,
			personalPrompt,
			hideFromChatHistory: request.hideFromChatHistory ?? false,
		},
	});
}

/** List ACP sessions for an agent via `session/list`. */
export async function listSessions(request: {
	agentId?: string;
	vaultPath?: string;
	cursor?: string;
}): Promise<AcpListSessionsResult> {
	return invokeApi("agent_list_sessions", {
		agentId: request.agentId ?? null,
		vaultPath: request.vaultPath ?? null,
		cursor: request.cursor ?? null,
	});
}

/** Load an ACP session's history via `session/load`. */
export async function loadSession(request: {
	agentId?: string;
	sessionId: string;
	vaultPath?: string;
}): Promise<AcpLoadSessionResult> {
	return invokeApi("agent_load_session", {
		agentId: request.agentId ?? null,
		sessionId: request.sessionId,
		vaultPath: request.vaultPath ?? null,
	});
}

/** Request cooperative cancellation of the active ACP session. */
export async function cancelAgentRun(sessionId: string): Promise<void> {
	await invokeApi<boolean>("agent_cancel_run", { sessionId });
}

/** Answer a pending ACP permission request (ask mode). `optionId = null` cancels. */
export async function respondPermission(
	requestId: string,
	optionId: string | null,
): Promise<void> {
	await invokeApi<{ resolved: boolean }>("agent_respond_permission", {
		request: { requestId, optionId },
	});
}

/** Revert a note the agent rewrote (trust loop) by restoring `content`. */
export async function revertNote(path: string, content: string): Promise<void> {
	const { writeTextFile } = await import("@tauri-apps/plugin-fs");
	await writeTextFile(path, content);
}

/** Start ACP in the background (no prompt) to prefetch models / usage for Chat UI. */
export async function warmAgent(request: {
	agentId?: string;
	vaultPath?: string;
	modelId?: string;
}): Promise<WarmResult> {
	return invokeApi("agent_warm", {
		request: {
			agentId: request.agentId,
			vaultPath: request.vaultPath,
			modelId: request.modelId,
		},
	});
}
