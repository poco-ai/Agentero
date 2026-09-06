import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import i18n from "@/i18n";
import {
	commands,
	events,
	type UpsertAgentRequest_Deserialize,
} from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { loadSettings } from "@/lib/settings";
import type { CatalogAcpStatus, CatalogEntry, ProbeResult } from "./api-types";

export type {
	AcpSessionCapabilities,
	CatalogAcpStatus,
	CatalogEntry,
	ProbeResult,
} from "./api-types";

export type AgentTemplate =
	| "opencode"
	| "openclaw"
	| "antigravity"
	| "hermes"
	| "claude-acp"
	| "codex-acp"
	| "qodercli"
	| "grok-build"
	| "pi"
	| "dsh"
	| "kimi-code"
	| "custom";

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

export type CatalogScanResponse = {
	entries: CatalogEntry[];
	customAgents: AgentDescriptor[];
	defaultId: string | null;
	enabled: boolean;
	proxyEnabled: boolean;
	proxyUrl: string;
	/** Optional ACP/Codex HTTP User-Agent override (empty = off). */
	userAgent?: string;
	/** Comma-separated Codex model_providers ids for http_headers injection. */
	userAgentProviderIds?: string;
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

export type PromptImage = {
	/** Raw base64 without data: prefix */
	data: string;
	mimeType: string;
};

export type AcpHistoryToolCall = {
	id: string;
	title: string;
	kind: string;
	status: string;
	input?: unknown;
	output?: unknown;
};

export type AcpHistoryPart =
	| { type: "reasoning"; text: string }
	| { type: "text"; text: string }
	| { type: "tool"; tool: AcpHistoryToolCall }
	| { type: "plan"; entries: AgentPlanEntry[] };

export type AcpHistoryLine = {
	id: string;
	kind: "user" | "agent";
	text: string;
	reasoning?: string | null;
	/** Ordered parts for agent lines (reasoning/text/tool/plan). */
	parts?: AcpHistoryPart[];
	sources?: string[];
	/** Visual PDF annotations attached to a user turn. */
	visualAnnotations?: {
		id: string;
		/** 1-based PDF page number. */
		page: number;
		comment: string;
		image: PromptImage;
		/** Vault-relative paper path when known. */
		paperPath?: string;
	}[];
	/** Multimodal images attached to a user turn. */
	images?: PromptImage[];
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

export type AgentSessionInfoEvent = {
	sessionId: string;
	agentId: string;
	providerSessionId?: string | null;
	title?: string | null;
	updatedAt?: string | null;
};

export type AgentCommand = {
	name: string;
	description: string;
	input?: { hint: string } | null;
};

export type AgentCommandsEvent = {
	sessionId: string;
	agentId: string;
	commands: AgentCommand[];
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

export type AgentModeChoice = {
	id: string;
	name: string;
	description?: string | null;
};

/** Codex collaboration mode (Default / Plan) via config id collaboration_mode. */
export type AgentCollaborationEvent = {
	sessionId: string;
	agentId: string;
	configId: string;
	currentId: string;
	modes: AgentModeChoice[];
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

/** One option for a form elicitation select field. */
export type ElicitationOption = {
	value: string;
	title: string;
	description?: string | null;
};

/** One field from ACP form elicitation (`elicitation/create`). */
export type ElicitationField = {
	id: string;
	title: string;
	description?: string | null;
	required: boolean;
	/** select | text | boolean | number | other */
	kind: string;
	options: ElicitationOption[];
	/** Codex free-text companion for the same logical question ("Other"). */
	isOtherAnswer?: boolean;
	/** Parent select field id when isOtherAnswer. */
	parentFieldId?: string | null;
};

/** ACP form elicitation request (Codex request_user_input). */
export type ElicitationRequest = {
	requestId: string;
	sessionId: string;
	message: string;
	toolCallId?: string | null;
	fields: ElicitationField[];
};

/** One option in a Grok `_x.ai/ask_user_question` (or similar) request. */
export type AskUserOptionDto = {
	label: string;
	description?: string | null;
};

/** One question in a Grok ask-user extension request. */
export type AskUserQuestionDto = {
	question: string;
	options: AskUserOptionDto[];
	multiSelect: boolean;
	allowOther: boolean;
};

/**
 * Grok Build ACP extension `_x.ai/ask_user_question` (Host → UI).
 * Not form elicitation; answers go back via `agent_respond_ask_user`.
 */
export type AskUserRequest = {
	requestId: string;
	sessionId: string;
	toolCallId?: string | null;
	/** default | plan */
	mode: string;
	questions: AskUserQuestionDto[];
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

/** Shared non-Tauri guard message for every agent Host call. */
const AGENT_CALL_OPTS = {
	desktopOnly: "Agent features require the Tauri desktop app.",
};

export async function listAgents(): Promise<AgentListResponse> {
	// Wire descriptors keep serde defaults optional; the Host always fills
	// args/env/available, so fold once at the boundary.
	return (await callApi(
		() => commands.agentListAgents(),
		AGENT_CALL_OPTS,
	)) as AgentListResponse;
}

export async function listAgentSkills(
	vaultPath?: string,
): Promise<AgentSkill[]> {
	return (await callApiResult(
		() => commands.agentListSkills(vaultPath ?? null),
		AGENT_CALL_OPTS,
	)) as AgentSkill[];
}

export async function scanCatalog(): Promise<CatalogScanResponse> {
	return (await callApi(
		() => commands.agentScanCatalog(),
		AGENT_CALL_OPTS,
	)) as CatalogScanResponse;
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
	const res = await callApi(
		() => commands.agentUpsertAgent(request as UpsertAgentRequest_Deserialize),
		AGENT_CALL_OPTS,
	);
	return res.agent as AgentDescriptor;
}

export async function ensureCatalogAgent(
	templateId: string,
	setDefault = false,
): Promise<AgentDescriptor> {
	const res = await callApi(
		() => commands.agentEnsureCatalog(templateId, setDefault),
		AGENT_CALL_OPTS,
	);
	return res.agent as AgentDescriptor;
}

export async function removeAgent(id: string): Promise<void> {
	await callApi(() => commands.agentRemoveAgent(id), AGENT_CALL_OPTS);
}

export async function setDefaultAgent(
	id: string | null,
): Promise<AgentListResponse> {
	return (await callApi(
		() => commands.agentSetDefault(id),
		AGENT_CALL_OPTS,
	)) as AgentListResponse;
}

/** Persist optional ACP User-Agent override for Codex / mid-station affinity. */
export async function setAgentUserAgent(
	userAgent: string,
	userAgentProviderIds = "",
): Promise<{ userAgent: string; userAgentProviderIds: string }> {
	return callApi(
		() => commands.agentSetUserAgent(userAgent, userAgentProviderIds),
		AGENT_CALL_OPTS,
	);
}

export async function probeAgent(id: string): Promise<ProbeResult> {
	return (await callApiResult(
		() => commands.agentProbe(id),
		AGENT_CALL_OPTS,
	)) as ProbeResult;
}

export async function probeCatalogAgent(
	templateId: string,
): Promise<ProbeResult> {
	return (await callApiResult(
		() => commands.agentProbeCatalog(templateId),
		AGENT_CALL_OPTS,
	)) as ProbeResult;
}

export type ToolLifecycleAction = "install" | "update" | "uninstall";

/**
 * Silently install, update or uninstall a catalog Agent CLI (and ACP adapter
 * when needed). Host only allows known templates — no free-form shell from the
 * UI. Uninstall also removes the registry entry on success.
 */
export async function runToolLifecycle(
	templateId: string,
	action: ToolLifecycleAction,
	taskId?: string,
): Promise<void> {
	await callApiResult(
		() => commands.agentRunToolLifecycle(templateId, action, taskId ?? null),
		AGENT_CALL_OPTS,
	);
}

export type UninstallInfo = {
	/** Complete `npm uninstall` commands (best-effort), mirroring install. */
	npmCommands: string[];
	/** Agentero-managed directories to delete (e.g. dsh launcher, kimi code). */
	dirs: string[];
};

/** What a silent uninstall of this template would remove; null if unsupported. */
export async function toolUninstallInfo(
	templateId: string,
): Promise<UninstallInfo | null> {
	return callApi(
		() => commands.agentToolUninstallInfo(templateId),
		AGENT_CALL_OPTS,
	);
}

export async function runOnce(request: {
	agentId?: string;
	/** Durable provider conversation id; Codex uses its native thread id. */
	sessionId?: string;
	prompt: string;
	isAcpCommand?: boolean;
	/** Multimodal crops for ACP Image content blocks */
	images?: PromptImage[];
	vaultPath?: string;
	workflow?: string;
	target?: string;
	/** ACP model config value id (from agent:models). */
	modelId?: string;
	/** Collaboration mode id (from agent:collaboration), e.g. default / plan. */
	collaborationModeId?: string;
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
	void import("@/lib/activity").then(({ track }) => {
		track("agent.run", {
			path: request.target,
			extra: {
				workflow: request.workflow ?? "free",
				skillCount: request.skillIds?.length ?? 0,
			},
		});
	});
	return callApiResult(
		() =>
			commands.agentRunOnce({
				agentId: request.agentId,
				sessionId: request.sessionId,
				prompt: request.prompt,
				isAcpCommand: request.isAcpCommand ?? false,
				images: request.images ?? [],
				vaultPath: request.vaultPath,
				workflow: request.workflow,
				target: request.target,
				modelId: request.modelId,
				collaborationModeId: request.collaborationModeId,
				reasoningEffort: request.reasoningEffort,
				fastMode: request.fastMode,
				skillIds: request.skillIds ?? [],
				autoApprove: request.autoApprove ?? false,
				permissionMode: request.permissionMode,
				responseLanguage,
				personalPrompt,
				hideFromChatHistory: request.hideFromChatHistory ?? false,
			}),
		AGENT_CALL_OPTS,
	);
}

/** List ACP sessions for an agent via `session/list`. */
export async function listSessions(request: {
	agentId?: string;
	vaultPath?: string;
	cursor?: string;
}): Promise<AcpListSessionsResult> {
	return (await callApiResult(
		() =>
			commands.agentListSessions(
				request.agentId ?? null,
				request.vaultPath ?? null,
				request.cursor ?? null,
			),
		AGENT_CALL_OPTS,
	)) as AcpListSessionsResult;
}

/** Load an ACP session's history via `session/load`. */
export async function loadSession(request: {
	agentId?: string;
	sessionId: string;
	vaultPath?: string;
}): Promise<AcpLoadSessionResult> {
	return (await callApiResult(
		() =>
			commands.agentLoadSession(
				request.agentId ?? null,
				request.sessionId,
				request.vaultPath ?? null,
			),
		AGENT_CALL_OPTS,
	)) as AcpLoadSessionResult;
}

/** Request cooperative cancellation of the active ACP session. */
export async function cancelAgentRun(sessionId: string): Promise<void> {
	await callApi(() => commands.agentCancelRun(sessionId), AGENT_CALL_OPTS);
}

/** Answer a pending ACP permission request (ask mode). `optionId = null` cancels. */
export async function respondPermission(
	requestId: string,
	optionId: string | null,
): Promise<void> {
	await callApi(
		() => commands.agentRespondPermission({ requestId, optionId }),
		AGENT_CALL_OPTS,
	);
}

/** Answer a pending ACP form elicitation. */
export async function respondElicitation(request: {
	requestId: string;
	action: "accept" | "decline" | "cancel";
	content?: Record<string, string>;
}): Promise<void> {
	await callApi(
		() =>
			commands.agentRespondElicitation({
				requestId: request.requestId,
				action: request.action,
				content: request.content ?? null,
			}),
		AGENT_CALL_OPTS,
	);
}

/** Answer a pending Grok `_x.ai/ask_user_question` extension request. */
export async function respondAskUser(request: {
	requestId: string;
	action: "accept" | "cancel";
	answers?: string[];
}): Promise<void> {
	await callApi(
		() =>
			commands.agentRespondAskUser({
				requestId: request.requestId,
				action: request.action,
				answers: request.answers ?? null,
			}),
		AGENT_CALL_OPTS,
	);
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
	collaborationModeId?: string;
}): Promise<WarmResult> {
	return callApiResult(
		() =>
			commands.agentWarm({
				agentId: request.agentId,
				vaultPath: request.vaultPath,
				modelId: request.modelId,
				collaborationModeId: request.collaborationModeId,
			}),
		AGENT_CALL_OPTS,
	);
}

export function listenAgentStream(
	handler: (e: AgentStreamEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentStream(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentCompleted(
	handler: (e: AgentResultPayload) => void,
): Promise<UnlistenFn> {
	return events
		.agentCompleted(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentFailed(
	handler: (e: AgentFailedEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentFailed(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentTool(
	handler: (e: AgentToolEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentTool(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentPlan(
	handler: (e: AgentPlanEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentPlan(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentUsage(
	handler: (e: AgentUsageEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentUsage(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentSessionInfo(
	handler: (e: AgentSessionInfoEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentSessionInfo(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentCommands(
	handler: (e: AgentCommandsEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentCommands(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentModels(
	handler: (e: AgentModelsEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentModels(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentEffort(
	handler: (e: AgentEffortEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentEffort(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentFastMode(
	handler: (e: AgentFastModeEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentFastMode(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

export function listenAgentCollaboration(
	handler: (e: AgentCollaborationEvent) => void,
): Promise<UnlistenFn> {
	return events
		.agentCollaboration(getCurrentWebviewWindow())
		.listen((message) => handler(message.payload));
}

const MODEL_PREF_KEY = "agentero-agent-model-pref";

/** Persist last chosen model id per agent. */
export function loadModelPref(agentId: string | null): string | null {
	if (!agentId) return null;
	const map = readJsonStorage<Record<string, string>>(MODEL_PREF_KEY, {});
	return typeof map[agentId] === "string" ? map[agentId] : null;
}

export function saveModelPref(agentId: string, modelId: string): void {
	const map = readJsonStorage<Record<string, string>>(MODEL_PREF_KEY, {});
	map[agentId] = modelId;
	writeJsonStorage(MODEL_PREF_KEY, map);
}

const COLLABORATION_PREF_KEY = "agentero-agent-collaboration-pref";

/** Persist last chosen collaboration mode (default / plan) per agent. */
export function loadCollaborationPref(agentId: string | null): string | null {
	if (!agentId) return null;
	const map = readJsonStorage<Record<string, string>>(
		COLLABORATION_PREF_KEY,
		{},
	);
	return typeof map[agentId] === "string" ? map[agentId] : null;
}

export function saveCollaborationPref(
	agentId: string,
	collaborationModeId: string,
): void {
	const map = readJsonStorage<Record<string, string>>(
		COLLABORATION_PREF_KEY,
		{},
	);
	map[agentId] = collaborationModeId;
	writeJsonStorage(COLLABORATION_PREF_KEY, map);
}

const MODEL_FAVORITES_KEY = "agentero-agent-model-favorites";

/** Per-agent ordered list of favorited model ids. */
export function loadModelFavorites(agentId: string | null): string[] {
	if (!agentId) return [];
	const map = readJsonStorage<Record<string, string[]>>(
		MODEL_FAVORITES_KEY,
		{},
	);
	const list = map[agentId];
	return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
}

export function saveModelFavorites(agentId: string, ids: string[]): void {
	const map = readJsonStorage<Record<string, string[]>>(
		MODEL_FAVORITES_KEY,
		{},
	);
	map[agentId] = ids;
	writeJsonStorage(MODEL_FAVORITES_KEY, map);
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
	const map = readJsonStorage<Record<string, CachedModelCatalog>>(
		MODEL_CATALOG_KEY,
		{},
	);
	return map[agentId] ?? null;
}

export function saveModelCatalog(
	agentId: string,
	catalog: CachedModelCatalog,
): void {
	const map = readJsonStorage<Record<string, CachedModelCatalog>>(
		MODEL_CATALOG_KEY,
		{},
	);
	map[agentId] = catalog;
	writeJsonStorage(MODEL_CATALOG_KEY, map);
}

export function isAgentAuthFailure(error?: string | null): boolean {
	if (!error) return false;
	return /invalid_grant|failed to authenticate|authentication failed|not authenticated|login required|unauthenticated|authentication required|authrequired|not logged in/i.test(
		error,
	);
}

export function acpStatusLabel(
	status: CatalogAcpStatus,
	error?: string | null,
): string {
	switch (status) {
		case "ready":
			return i18n.t("agent:acpStatus.ready");
		case "failed":
			if (isAgentAuthFailure(error)) {
				return i18n.t("agent:acpStatus.notLoggedIn");
			}
			return i18n.t("agent:acpStatus.failed");
		case "not-probed":
			return i18n.t("agent:acpStatus.notProbed");
		case "missing":
			return i18n.t("agent:acpStatus.notInstalled");
	}
}
