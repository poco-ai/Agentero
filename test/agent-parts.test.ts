import { describe, expect, it } from "vitest";
import {
	type AgentPart,
	agentHasContent,
	agentReasoningFromParts,
	agentTextFromParts,
	appendStreamPart,
	applyToolToParts,
	dedupeModelsClient,
	mapToolStatus,
	mergeToolState,
	toolPartState,
	upsertPlanPart,
} from "@/lib/agent-parts";

describe("appendStreamPart", () => {
	it("extends the trailing part of the same kind", () => {
		let parts: AgentPart[] = [];
		parts = appendStreamPart(parts, "text", "Hello ");
		parts = appendStreamPart(parts, "text", "world");
		expect(parts).toHaveLength(1);
		expect(agentTextFromParts(parts)).toBe("Hello world");
	});

	it("starts a new part when the kind switches", () => {
		let parts: AgentPart[] = [];
		parts = appendStreamPart(parts, "reasoning", "think");
		parts = appendStreamPart(parts, "text", "answer");
		parts = appendStreamPart(parts, "reasoning", "more");
		expect(parts.map((p) => p.type)).toEqual([
			"reasoning",
			"text",
			"reasoning",
		]);
		expect(agentReasoningFromParts(parts)).toBe("think\n\nmore");
		expect(agentTextFromParts(parts)).toBe("answer");
	});
});

describe("applyToolToParts", () => {
	it("appends a new tool part then updates it in place", () => {
		let parts: AgentPart[] = [];
		parts = applyToolToParts(parts, {
			id: "t1",
			title: "Read",
			status: "pending",
		});
		expect(parts).toHaveLength(1);
		const toolId = (parts[0] as Extract<AgentPart, { type: "tool" }>).id;
		parts = applyToolToParts(parts, { id: "t1", status: "completed" });
		expect(parts).toHaveLength(1);
		const tool = parts[0] as Extract<AgentPart, { type: "tool" }>;
		expect(tool.id).toBe(toolId); // position/id preserved
		expect(tool.tool.status).toBe("completed");
		expect(tool.tool.title).toBe("Read"); // carried over
	});
});

describe("upsertPlanPart", () => {
	it("keeps a single plan part and replaces its entries", () => {
		let parts: AgentPart[] = [{ type: "text", id: "x", text: "hi" }];
		parts = upsertPlanPart(parts, [
			{ content: "a", status: "pending", priority: "high" },
		]);
		parts = upsertPlanPart(parts, [
			{ content: "a", status: "completed", priority: "high" },
			{ content: "b", status: "pending", priority: "low" },
		]);
		const plans = parts.filter((p) => p.type === "plan");
		expect(plans).toHaveLength(1);
		expect(
			(plans[0] as Extract<AgentPart, { type: "plan" }>).entries,
		).toHaveLength(2);
	});
});

describe("mergeToolState / mapToolStatus / toolPartState", () => {
	it("normalizes unknown status to pending", () => {
		expect(mapToolStatus(undefined)).toBe("pending");
		expect(mapToolStatus("weird")).toBe("pending");
		expect(mapToolStatus("failed")).toBe("failed");
	});

	it("merges patch over previous, preserving untouched fields", () => {
		const first = mergeToolState(undefined, {
			id: "t",
			title: "Edit",
			status: "in_progress",
		});
		const merged = mergeToolState(first, { id: "t", output: 42 });
		expect(merged.title).toBe("Edit");
		expect(merged.status).toBe("in_progress");
		expect(merged.output).toBe(42);
	});

	it("maps ui status to AI-Elements part state", () => {
		expect(toolPartState("completed")).toBe("output-available");
		expect(toolPartState("failed")).toBe("output-error");
		expect(toolPartState("pending")).toBe("input-streaming");
	});
});

describe("agentHasContent", () => {
	it("is false for empty/whitespace-only parts and true for a tool", () => {
		expect(agentHasContent([{ type: "text", id: "1", text: "  " }])).toBe(
			false,
		);
		expect(
			agentHasContent([
				{
					type: "tool",
					id: "2",
					tool: { id: "t", title: "", kind: "", status: "pending" },
				},
			]),
		).toBe(true);
	});
});

describe("dedupeModelsClient", () => {
	it("drops duplicate ids and case-insensitive duplicate names", () => {
		const out = dedupeModelsClient([
			{ id: "a", name: "GPT" },
			{ id: "a", name: "GPT copy" }, // dup id
			{ id: "b", name: "gpt" }, // dup name (case)
			{ id: "c", name: "Claude" },
			{ id: "", name: "blank" }, // dropped: empty id
		]);
		expect(out.map((m) => m.id)).toEqual(["a", "c"]);
	});
});
