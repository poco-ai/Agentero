export type MobileReaderMode = "pdf" | "notes";

export type AgentLine = {
	id: string;
	role: "assistant" | "user";
	text: string;
	streaming?: boolean;
};

export type AgentPermissionOption = {
	optionId: string;
	name: string;
	kind: string;
};

export type AgentPermissionRequest = {
	requestId: string;
	sessionId: string;
	title: string;
	paths: string[];
	options: AgentPermissionOption[];
	host?: string | null;
};

export type AgentStreamEvent = {
	sessionId: string;
	chunk: string;
};

export type AgentResultEvent = {
	sessionId: string;
	content: string;
};

export type AgentFailedEvent = {
	sessionId: string;
	error?: string;
};

/** Loading phase of a turn bridged from the desktop host. */
export type AgentTurnPhase = "starting" | "waiting-model" | "reconnecting";

export type AgentStatusEvent = {
	sessionId: string;
	phase: AgentTurnPhase;
	/** e.g. "2/5" attempt counter for reconnecting. */
	detail?: string | null;
};

export type AcpSessionInfo = {
	sessionId: string;
	title?: string;
	updatedAt?: string;
};

export type AcpListSessionsResult = {
	sessions: AcpSessionInfo[];
	supported: boolean;
};

export type AcpHistoryLine = {
	id: string;
	kind: string;
	text: string;
};

export type AcpLoadSessionResult = {
	sessionId: string;
	title?: string;
	lines: AcpHistoryLine[];
};
