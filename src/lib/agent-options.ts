//! Pure helpers for the Chat agent switcher: build the availability-filtered
//! option list, resolve the selected agent, and classify history titles.
//! Extracted from `agent-panel.tsx` for unit testing.

import type { AgentListResponse, CatalogScanResponse } from "@/lib/agent";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent-prompt-display";

export type AgentOption = {
	key: string;
	id: string | null;
	templateId: string | null;
	name: string;
	available: boolean;
	isDefault: boolean;
	source: "registry" | "catalog";
};

/** Empty-state suggestion chips — one per row. Labels via i18n. */
export const SUGGESTION_KEYS = [
	"summarizePaper",
	"askLibrary",
	"listClaims",
	"draftRelatedWork",
] as const;

export type SuggestionKey = (typeof SUGGESTION_KEYS)[number];

/**
 * Each suggestion routes to a purpose-built backend workflow so the agent gets
 * the right system prompt (progressive disclosure, citation discipline, …)
 * instead of a generic free-form chat.
 */
export const SUGGESTION_WORKFLOW: Record<SuggestionKey, string> = {
	summarizePaper: "summary",
	askLibrary: "qa",
	listClaims: "qa",
	draftRelatedWork: "related_work",
};

/**
 * Background workflows (paper-reader, etc.) must not appear in Agent chat history.
 * Matches titles already indexed before hideFromChatHistory existed.
 */
export function isBackgroundWorkflowHistoryTitle(title: string): boolean {
	const t = stripPromptEnvelopeForDisplay(title).toLowerCase();
	const raw = title.toLowerCase();
	return (
		raw.includes("paper-reader") ||
		raw.includes("paper_reader") ||
		raw.includes("agentero paper-reader") ||
		raw.includes("write structured lecture notes") ||
		raw.includes("activate and follow $paper-reader") ||
		raw.includes("activate and follow /paper-reader") ||
		raw.includes("you are running the agentero paper-reader") ||
		t.includes("activate and follow $paper-reader") ||
		t.includes("write structured lecture notes")
	);
}

/** Catalog entry is usable in Chat only when ACP handshake succeeded. */
export function catalogEntryUsable(e: {
	acpStatus: string;
	binaryAvailable: boolean;
	acpCommandAvailable: boolean;
}): boolean {
	return e.acpStatus === "ready";
}

export function registryAgentUsable(a: {
	available: boolean;
	lastProbeOk?: boolean | null;
}): boolean {
	return a.available || a.lastProbeOk === true;
}

/**
 * Agents shown in the Chat header switcher.
 * Unavailable ACP backends are omitted entirely (not shown as disabled).
 */
export function buildOptions(
	registry: AgentListResponse | null,
	catalog: CatalogScanResponse | null,
): AgentOption[] {
	const options: AgentOption[] = [];
	const seenIds = new Set<string>();

	if (catalog) {
		for (const e of catalog.entries) {
			if (!catalogEntryUsable(e)) continue;
			const id = e.registeredId ?? null;
			if (id) seenIds.add(id);
			options.push({
				key: `catalog:${e.templateId}`,
				id,
				templateId: e.templateId,
				name: e.name,
				available: true,
				isDefault: e.isDefault,
				source: "catalog",
			});
		}
		for (const a of catalog.customAgents) {
			if (!registryAgentUsable(a)) continue;
			if (seenIds.has(a.id)) continue;
			seenIds.add(a.id);
			options.push({
				key: `reg:${a.id}`,
				id: a.id,
				templateId: null,
				name: a.name,
				available: true,
				isDefault: catalog.defaultId === a.id,
				source: "registry",
			});
		}
	}

	if (registry) {
		for (const a of registry.agents) {
			if (!registryAgentUsable(a)) continue;
			if (seenIds.has(a.id)) continue;
			seenIds.add(a.id);
			options.push({
				key: `reg:${a.id}`,
				id: a.id,
				templateId: null,
				name: a.name,
				available: true,
				isDefault: registry.defaultId === a.id,
				source: "registry",
			});
		}
	}

	return options;
}

export function resolveSelected(
	options: AgentOption[],
	selectedId: string | null,
	registry: AgentListResponse | null,
): AgentOption | undefined {
	// options is already availability-filtered
	if (selectedId) {
		const byId = options.find((o) => o.id === selectedId);
		if (byId) return byId;
	}
	const def = options.find((o) => o.isDefault);
	if (def) return def;
	if (registry?.defaultId) {
		const byDefault = options.find((o) => o.id === registry.defaultId);
		if (byDefault) return byDefault;
	}
	return options[0];
}
