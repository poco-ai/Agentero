//! Pure helpers for assembling an agent turn's ordered parts (reasoning, text,
//! tool calls, plan) and normalizing tool/model data. Extracted from
//! `agent-panel.tsx` so the transcript-assembly logic is unit-testable.

import type { ToolUIPart } from "ai";
import type { AgentModelChoice, AgentPlanEntry } from "@/lib/agent";

export type ToolUiState = {
	id: string;
	title: string;
	kind: string;
	status: "pending" | "in_progress" | "completed" | "failed";
	input?: unknown;
	output?: unknown;
};

/**
 * Ordered slice of an agent turn. Reasoning, tool calls, plan and message text
 * are stored in the sequence the agent emitted them so the transcript can show
 * interleaved thinking (think → tool → think → answer) instead of grouping all
 * reasoning and tools into fixed blocks.
 */
export type AgentPart =
	| { type: "reasoning"; id: string; text: string }
	| { type: "text"; id: string; text: string }
	| { type: "tool"; id: string; tool: ToolUiState }
	| { type: "plan"; id: string; entries: AgentPlanEntry[] };

export type ToolPatch = {
	id: string;
	title?: string | null;
	kind?: string | null;
	status?: string | null;
	input?: unknown;
	output?: unknown;
	full?: boolean;
};

let agentPartSeq = 0;
export function nextPartId(prefix: string): string {
	agentPartSeq += 1;
	return `${prefix}-${agentPartSeq}`;
}

export function mapToolStatus(
	status: string | null | undefined,
): ToolUiState["status"] {
	switch (status) {
		case "in_progress":
			return "in_progress";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		default:
			return "pending";
	}
}

export function toolPartState(
	status: ToolUiState["status"],
): ToolUIPart["state"] {
	switch (status) {
		case "in_progress":
			return "input-available";
		case "completed":
			return "output-available";
		case "failed":
			return "output-error";
		default:
			return "input-streaming";
	}
}

export function mergeToolState(
	prev: ToolUiState | undefined,
	patch: ToolPatch,
): ToolUiState {
	return {
		id: patch.id,
		title: patch.title ?? prev?.title ?? "",
		kind: patch.kind ?? prev?.kind ?? "other",
		status: mapToolStatus(patch.status ?? prev?.status),
		input: patch.input !== undefined ? patch.input : prev?.input,
		output: patch.output !== undefined ? patch.output : prev?.output,
	};
}

/**
 * Append a streamed message/thought chunk, extending the trailing part when it
 * matches so consecutive chunks of the same kind stay in one block but a switch
 * of kind (thought → message or vice versa) starts a fresh, ordered part.
 */
export function appendStreamPart(
	parts: AgentPart[],
	kind: "reasoning" | "text",
	chunk: string,
): AgentPart[] {
	const last = parts[parts.length - 1];
	if (last && last.type === kind) {
		const next = parts.slice();
		next[next.length - 1] = { ...last, text: last.text + chunk };
		return next;
	}
	return [...parts, { type: kind, id: nextPartId(kind), text: chunk }];
}

/**
 * Upsert a tool call by id: update the existing part in place (keeping its
 * position in the timeline) or append a new tool part at the current tail.
 */
export function applyToolToParts(
	parts: AgentPart[],
	patch: ToolPatch,
): AgentPart[] {
	const idx = parts.findIndex(
		(p) => p.type === "tool" && p.tool.id === patch.id,
	);
	if (idx >= 0) {
		const existing = parts[idx] as Extract<AgentPart, { type: "tool" }>;
		const next = parts.slice();
		next[idx] = { ...existing, tool: mergeToolState(existing.tool, patch) };
		return next;
	}
	return [
		...parts,
		{
			type: "tool",
			id: nextPartId("tool"),
			tool: mergeToolState(undefined, patch),
		},
	];
}

/** Plan updates arrive as full snapshots; keep a single plan part in place. */
export function upsertPlanPart(
	parts: AgentPart[],
	entries: AgentPlanEntry[],
): AgentPart[] {
	const idx = parts.findIndex((p) => p.type === "plan");
	if (idx >= 0) {
		const existing = parts[idx] as Extract<AgentPart, { type: "plan" }>;
		const next = parts.slice();
		next[idx] = { ...existing, entries };
		return next;
	}
	return [...parts, { type: "plan", id: nextPartId("plan"), entries }];
}

export function agentTextFromParts(parts: AgentPart[]): string {
	return parts
		.filter((p): p is Extract<AgentPart, { type: "text" }> => p.type === "text")
		.map((p) => p.text)
		.join("");
}

export function agentReasoningFromParts(parts: AgentPart[]): string {
	return parts
		.filter(
			(p): p is Extract<AgentPart, { type: "reasoning" }> =>
				p.type === "reasoning",
		)
		.map((p) => p.text)
		.join("\n\n");
}

/** True when the turn has produced anything worth keeping on screen. */
export function agentHasContent(parts: AgentPart[]): boolean {
	return parts.some((p) => {
		if (p.type === "text" || p.type === "reasoning") {
			return p.text.trim().length > 0;
		}
		if (p.type === "plan") return p.entries.length > 0;
		return true;
	});
}

/** Client-side dedupe (id first, then display name) for cached/stale catalogs. */
export function dedupeModelsClient(
	models: AgentModelChoice[],
): AgentModelChoice[] {
	const seenIds = new Set<string>();
	const seenNames = new Set<string>();
	const out: AgentModelChoice[] = [];
	for (const m of models) {
		const id = m.id.trim();
		const nameKey = m.name.trim().toLowerCase();
		if (!id || !nameKey) continue;
		if (seenIds.has(id) || seenNames.has(nameKey)) continue;
		seenIds.add(id);
		seenNames.add(nameKey);
		out.push({
			id,
			name: m.name.trim(),
			group: m.group,
		});
	}
	return out;
}
