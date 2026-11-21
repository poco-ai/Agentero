import {
	readJsonStorage,
	removeStorageKey,
	type StorageLike,
	writeJsonStorage,
} from "@/lib/core/storage";

export type AgentComposerState = {
	text: string;
	mentionedPaths: string[];
	selectedSkillIds: string[];
	includeSelectedFile: boolean;
};

/** Storage surface for composer draft + mention recents (tests inject mocks). */
export type ComposerStateStorage = StorageLike;

const COMPOSER_STATE_PREFIX = "agentero-agent-composer-state-v1";

function uniqueStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value.filter((item): item is string => typeof item === "string"),
		),
	];
}

function parseState(value: unknown): AgentComposerState | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Partial<AgentComposerState>;
	return {
		text: typeof candidate.text === "string" ? candidate.text : "",
		mentionedPaths: uniqueStrings(candidate.mentionedPaths),
		selectedSkillIds: uniqueStrings(candidate.selectedSkillIds),
		includeSelectedFile: candidate.includeSelectedFile === true,
	};
}

function removeSubmittedStrings(current: string[], submitted: string[]) {
	const submittedSet = new Set(submitted);
	return current.filter((value) => !submittedSet.has(value));
}

export function clearSubmittedComposerState(
	current: AgentComposerState,
	submitted: AgentComposerState,
): AgentComposerState {
	return {
		text: current.text === submitted.text ? "" : current.text,
		mentionedPaths: removeSubmittedStrings(
			current.mentionedPaths,
			submitted.mentionedPaths,
		),
		selectedSkillIds: removeSubmittedStrings(
			current.selectedSkillIds,
			submitted.selectedSkillIds,
		),
		// Current paper/file stays in context by default across turns; only
		// explicit user removal (or a newer draft edit) changes this flag.
		includeSelectedFile: current.includeSelectedFile,
	};
}

function storageKey(scopeKey: string, sessionId: string) {
	return `${COMPOSER_STATE_PREFIX}:${encodeURIComponent(scopeKey)}:${encodeURIComponent(sessionId)}`;
}

/**
 * Draft storage scope. `surfaceId` separates chat surfaces (Zen slots) that
 * share an agent; the rail passes null and keeps its original keys.
 */
export function composerScopeKey(
	vaultPath: string | null,
	agentId: string | null,
	surfaceId: string | null = null,
): string | null {
	if (!vaultPath || !agentId) return null;
	return JSON.stringify(
		surfaceId ? [vaultPath, agentId, surfaceId] : [vaultPath, agentId],
	);
}

export function loadAgentComposerState(
	storage: ComposerStateStorage,
	scopeKey: string,
	sessionId: string,
): AgentComposerState | null {
	const raw = readJsonStorage<unknown>(
		storageKey(scopeKey, sessionId),
		null,
		storage,
	);
	return parseState(raw);
}

export function saveAgentComposerState(
	storage: ComposerStateStorage,
	scopeKey: string,
	sessionId: string,
	state: AgentComposerState,
) {
	// Persistence is best-effort; the in-memory Composer remains usable.
	writeJsonStorage(storageKey(scopeKey, sessionId), state, storage);
}

export function removeAgentComposerState(
	storage: ComposerStateStorage,
	scopeKey: string,
	sessionId: string,
) {
	removeStorageKey(storageKey(scopeKey, sessionId), storage);
}
