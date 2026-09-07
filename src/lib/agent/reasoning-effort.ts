import type { AgentEffortChoice } from "@/lib/agent/api";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

const EFFORT_PREF_KEY = "agentero-agent-reasoning-effort-pref";

// ACP has no universal strength ordering. Keep in sync with session/config.rs.
const EFFORT_ORDER = [
	"none",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
];

/** Only explicit user choices are persisted; ACP defaults remain agent-owned. */
export function loadReasoningEffortPref(agentId: string | null): string | null {
	if (!agentId) return null;
	const map = readJsonStorage<Record<string, string> | null>(
		EFFORT_PREF_KEY,
		{},
	);
	const value = map?.[agentId];
	return typeof value === "string" ? value.trim() || null : null;
}

export function saveReasoningEffortPref(agentId: string, effort: string): void {
	const map = readJsonStorage<Record<string, string> | null>(
		EFFORT_PREF_KEY,
		{},
	);
	writeJsonStorage(EFFORT_PREF_KEY, { ...map, [agentId]: effort });
}

/** Resolve the next-turn selection against the current model's ACP choices. */
export function resolveReasoningEffort(
	preferred: string | null,
	current: string,
	choices: AgentEffortChoice[],
): string | null {
	if (!choices.length) return null;
	if (preferred && choices.some((choice) => choice.id === preferred)) {
		return preferred;
	}
	if (!preferred) {
		const ranked = choices.map((choice) => ({
			choice,
			rank: EFFORT_ORDER.indexOf(choice.id.toLowerCase()),
		}));
		// Unknown Agent-specific values cannot be ordered safely from array position.
		if (ranked.every(({ rank }) => rank >= 0)) {
			return ranked.reduce((best, item) =>
				item.rank > best.rank ? item : best,
			).choice.id;
		}
	}
	return current.trim() || null;
}
