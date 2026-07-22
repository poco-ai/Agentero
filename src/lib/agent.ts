import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import i18n from "@/i18n";
import { loadSettings } from "@/lib/settings";
import { isTauri } from "@/lib/tauri";

export type AgentTemplate =
	| "opencode"
	| "gemini"
	| "claude-acp"
	| "codex-acp"
	| "qodercli"
	| "grok-build"
	| "custom";

export type CatalogAcpStatus = "missing" | "not-probed" | "ready" | "failed";

export type AgentDescriptor = {
	id: string;
	name: string;
	template: AgentTemplate;
	command: string;
	args: string[];
	env: Record<string, string>;
	available: boolean;
	lastError?: string | null;
	lastProbeOk?: boolean | null;
	lastProbeAgentName?: string | null;
	lastProbeError?: string | null;
	lastProbedAt?: string | null;
};

export type AgentListResponse = {
	agents: AgentDescriptor[];
	defaultId: string | null;
	enabled: boolean;
};

export type AgentTemplateInfo = {
	id: string;
	name: string;
	description?: string;
	command: string;
	args: string[];
	detectCommand?: string | null;
	installHint: string;
};

export type CatalogEntry = {
	templateId: string;
	name: string;
	description: string;
	command: string;
	args: string[];
	installHint: string;
	/** Shell command for guided install (e.g. Claude ACP adapter via npm). */
	installCommand?: string | null;
	/** Host CLI present but ACP entrypoint missing — show install button. */
	offerInstall?: boolean;
	binaryAvailable: boolean;
	resolvedPath?: string | null;
	acpCommandAvailable: boolean;
	acpStatus: CatalogAcpStatus;
	registeredId?: string | null;
	isDefault: boolean;
	acpAgentName?: string | null;
	lastProbeError?: string | null;
	lastProbedAt?: string | null;
};

export type CatalogScanResponse = {
	entries: CatalogEntry[];
	customAgents: AgentDescriptor[];
	defaultId: string | null;
	enabled: boolean;
	proxyEnabled: boolean;
	proxyUrl: string;
};

export type AcpSessionCapabilities = {
	list: boolean;
	resume: boolean;
	load: boolean;
	delete: boolean;
};

export type ProbeResult = {
	agentId: string;
	available: boolean;
	agentName?: string | null;
	protocolVersion?: string | null;
	error?: string | null;
	sessionCapabilities?: AcpSessionCapabilities | null;
};

export type AcpSessionInfo = {
	sessionId: string;
	cwd: string;
	title?: string | null;
	updatedAt?: string | null;
};

export type AcpListSessionsResult = {
	sessions: AcpSessionInfo[];
	nextCursor?: string | null;
	supported: boolean;
};

export type AcpHistoryLine = {
	id: string;
	kind: "user" | "agent";
	text: string;
	reasoning?: string | null;
};

export type AcpLoadSessionResult = {
	sessionId: string;
	title?: string | null;
	lines: AcpHistoryLine[];
};

export type RunOnceAccepted = {
	sessionId: string;
	messageId: string;
	agentId: string;
};

export type AgentSkill = {
	id: string;
	name: string;
	description: string;
};

export type AgentResultPayload = {
	sessionId: string;
	messageId: string;
	content: string;
	/** ACP agent thought / reasoning text, if the agent emitted thought chunks. */
	reasoning?: string | null;
	sources: string[];
	stopReason?: string | null;
	/** Durable ACP provider session id for the next `session/resume`. */
	providerSessionId?: string | null;
};

export type AgentStreamKind = "message" | "thought";

export type AgentStreamEvent = {
	sessionId: string;
	chunk: string;
	/** Defaults to message when older backends omit the field. */
	kind?: AgentStreamKind;
};

export type AgentToolEvent = {
	sessionId: string;
	toolCallId: string;
	title?: string | null;
	kind?: string | null;
	/** pending | in_progress | completed | failed */
	status?: string | null;
	input?: unknown;
	output?: unknown;
	full?: boolean;
};

export type AgentPlanEntry = {
	content: string;
	status: string;
	priority: string;
};

export type AgentPlanEvent = {
	sessionId: string;
	entries: AgentPlanEntry[];
};

export type AgentUsageEvent = {
	sessionId: string;
	used: number;
	size: number;
};

export type AgentModelChoice = {
	id: string;
	name: string;
	group?: string | null;
};

export type AgentModelsEvent = {
	sessionId: string;
	agentId: string;
	configId: string;
	currentId: string;
	models: AgentModelChoice[];
};

export type AgentEffortChoice = {
	id: string;
	name: string;
	description?: string | null;
};

export type AgentEffortEvent = {
	sessionId: string;
	agentId: string;
	configId: string;
	currentId: string;
	efforts: AgentEffortChoice[];
};

export type AgentFastModeEvent = {
	sessionId: string;
	agentId: string;
	configId: string;
	enabled: boolean;
};

export type AgentFailedEvent = {
	sessionId: string;
	error: string;
};

export type PermissionOption = {
	optionId: string;
	name: string;
	/** allow_once | allow_always | reject_once | reject_always | other */
	kind: string;
};

/** ACP permission request forwarded to the user in "ask" mode. */
export type PermissionRequest = {
	requestId: string;
	sessionId: string;
	title: string;
	kind?: string | null;
	paths: string[];
	options: PermissionOption[];
};

/** A note an agent rewrote during a run, offered for keep / revert. */
export type NotesReview = {
	path: string;
	before: string;
	after: string;
};

async function invokeApi<T>(
	cmd: string,
	args?: Record<string, unknown>,
): Promise<T> {
	if (!isTauri()) {
		throw new Error("Agent features require the Tauri desktop app.");
	}
	const { ipc } = await import("@/lib/ipc");
	return ipc<T>(cmd, args);
}

export async function listAgents(): Promise<AgentListResponse> {
	return invokeApi("agent_list_agents");
}

export async function listTemplates(): Promise<AgentTemplateInfo[]> {
	const res = await invokeApi<{ templates: AgentTemplateInfo[] }>(
		"agent_list_templates",
	);
	return res.templates;
}

export async function listAgentSkills(
	vaultPath?: string,
): Promise<AgentSkill[]> {
	return invokeApi("agent_list_skills", { vaultPath: vaultPath ?? null });
}

export async function scanCatalog(): Promise<CatalogScanResponse> {
	return invokeApi("agent_scan_catalog");
}

export async function upsertAgent(request: {
	id?: string;
	name: string;
	template?: AgentTemplate;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	setDefault?: boolean;
}): Promise<AgentDescriptor> {
	const res = await invokeApi<{ agent: AgentDescriptor }>(
		"agent_upsert_agent",
		{ request },
	);
	return res.agent;
}

export async function ensureCatalogAgent(
	templateId: string,
	setDefault = false,
): Promise<AgentDescriptor> {
	const res = await invokeApi<{ agent: AgentDescriptor }>(
		"agent_ensure_catalog",
		{ templateId, setDefault },
	);
	return res.agent;
}

export async function removeAgent(id: string): Promise<void> {
	await invokeApi("agent_remove_agent", { id });
}

export async function setDefaultAgent(
	id: string | null,
): Promise<AgentListResponse> {
	return invokeApi("agent_set_default", { id });
}

export async function setAgentEnabled(enabled: boolean): Promise<boolean> {
	const res = await invokeApi<{ enabled: boolean }>("agent_set_enabled", {
		enabled,
	});
	return res.enabled;
}

export async function setAgentProxy(
	proxyEnabled: boolean,
	proxyUrl: string,
): Promise<{ proxyEnabled: boolean; proxyUrl: string }> {
	return invokeApi("agent_set_proxy", { proxyEnabled, proxyUrl });
}

export async function discoverAgents(id?: string): Promise<AgentListResponse> {
	return invokeApi("agent_discover", { id: id ?? null });
}

export async function probeAgent(id: string): Promise<ProbeResult> {
	return invokeApi("agent_probe", { id });
}

export async function probeCatalogAgent(
	templateId: string,
): Promise<ProbeResult> {
	return invokeApi("agent_probe_catalog", { templateId });
}

/**
 * Open the system terminal with the template's install command and wait for
 * the user to confirm (Enter) before running. Host only allows known templates.
 */
export async function openInstallTerminal(templateId: string): Promise<void> {
	await invokeApi("agent_open_install_terminal", { templateId });
}

export type PromptImage = {
	/** Raw base64 without data: prefix */
	data: string;
	mimeType: string;
};

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

export type WarmResult = {
	agentId: string;
	ok: boolean;
	models?: AgentModelsEvent | null;
	usageUsed?: number | null;
	usageSize?: number | null;
	error?: string | null;
};

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

const MODEL_PREF_KEY = "agentero-agent-model-pref";

/** Persist last chosen model id per agent. */
export function loadModelPref(agentId: string | null): string | null {
	if (!agentId) return null;
	try {
		const raw = localStorage.getItem(MODEL_PREF_KEY);
		if (!raw) return null;
		const map = JSON.parse(raw) as Record<string, string>;
		return map[agentId] ?? null;
	} catch {
		return null;
	}
}

export function saveModelPref(agentId: string, modelId: string): void {
	try {
		const raw = localStorage.getItem(MODEL_PREF_KEY);
		const map = (raw ? JSON.parse(raw) : {}) as Record<string, string>;
		map[agentId] = modelId;
		localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(map));
	} catch {
		// ignore
	}
}

const MODEL_FAVORITES_KEY = "agentero-agent-model-favorites";

/** Per-agent ordered list of favorited model ids. */
export function loadModelFavorites(agentId: string | null): string[] {
	if (!agentId) return [];
	try {
		const raw = localStorage.getItem(MODEL_FAVORITES_KEY);
		if (!raw) return [];
		const map = JSON.parse(raw) as Record<string, string[]>;
		const list = map[agentId];
		return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

export function saveModelFavorites(agentId: string, ids: string[]): void {
	try {
		const raw = localStorage.getItem(MODEL_FAVORITES_KEY);
		const map = (raw ? JSON.parse(raw) : {}) as Record<string, string[]>;
		map[agentId] = ids;
		localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(map));
	} catch {
		// ignore
	}
}

const MODEL_CATALOG_KEY = "agentero-agent-model-catalog";

export type CachedModelCatalog = {
	configId: string;
	currentId: string;
	models: AgentModelChoice[];
};

export function loadModelCatalog(
	agentId: string | null,
): CachedModelCatalog | null {
	if (!agentId) return null;
	try {
		const raw = localStorage.getItem(MODEL_CATALOG_KEY);
		if (!raw) return null;
		const map = JSON.parse(raw) as Record<string, CachedModelCatalog>;
		return map[agentId] ?? null;
	} catch {
		return null;
	}
}

export function saveModelCatalog(
	agentId: string,
	catalog: CachedModelCatalog,
): void {
	try {
		const raw = localStorage.getItem(MODEL_CATALOG_KEY);
		const map = (raw ? JSON.parse(raw) : {}) as Record<
			string,
			CachedModelCatalog
		>;
		map[agentId] = catalog;
		localStorage.setItem(MODEL_CATALOG_KEY, JSON.stringify(map));
	} catch {
		// ignore
	}
}

export function acpStatusLabel(status: CatalogAcpStatus): string {
	switch (status) {
		case "ready":
			return i18n.t("agent:acpStatus.ready");
		case "failed":
			return i18n.t("agent:acpStatus.failed");
		case "not-probed":
			return i18n.t("agent:acpStatus.notProbed");
		case "missing":
			return i18n.t("agent:acpStatus.notInstalled");
	}
}
