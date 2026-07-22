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

export type PromptImage = {
	/** Raw base64 without data: prefix */
	data: string;
	mimeType: string;
};

export type WarmResult = {
	agentId: string;
	ok: boolean;
	models?: AgentModelsEvent | null;
	usageUsed?: number | null;
	usageSize?: number | null;
	error?: string | null;
};

export type CachedModelCatalog = {
	configId: string;
	currentId: string;
	models: AgentModelChoice[];
};
