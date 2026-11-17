import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { AgentPhaseState } from "@/lib/agent/api";
import { type AgentPart, streamingLabel } from "@/lib/agent/chat-state";
import {
	classifyStreamChunk,
	promoteOrphanThoughtToText,
	ThinkTagParser,
} from "@/lib/agent/stream-parse";

describe("ThinkTagParser", () => {
	it("splits think block from following answer in one chunk", () => {
		const p = new ThinkTagParser();
		const slices = p.push(
			"<think>step one\nstep two</think>\n\n## Final answer\n42",
		);
		expect(slices).toEqual([
			{ kind: "reasoning", text: "step one\nstep two" },
			{ kind: "text", text: "\n\n## Final answer\n42" },
		]);
	});

	it("handles open/close tags split across chunks", () => {
		const p = new ThinkTagParser();
		expect(p.push("<thi")).toEqual([]);
		expect(p.push("nk>hidden")).toEqual([
			{ kind: "reasoning", text: "hidden" },
		]);
		expect(p.push(" mind</thi")).toEqual([
			{ kind: "reasoning", text: " mind" },
		]);
		expect(p.push("nk>visible")).toEqual([{ kind: "text", text: "visible" }]);
	});

	it("treats plain message as text", () => {
		const p = new ThinkTagParser();
		expect(p.push("hello world")).toEqual([
			{ kind: "text", text: "hello world" },
		]);
	});

	it("supports thinking and reasoning tag aliases", () => {
		const p = new ThinkTagParser();
		const a = p.push("<thinking>a</thinking>b");
		expect(a).toEqual([
			{ kind: "reasoning", text: "a" },
			{ kind: "text", text: "b" },
		]);
		p.reset();
		const b = p.push("<reasoning>x</reasoning>y");
		expect(b).toEqual([
			{ kind: "reasoning", text: "x" },
			{ kind: "text", text: "y" },
		]);
	});
});

describe("classifyStreamChunk", () => {
	it("maps thought kind to reasoning when no tags", () => {
		const p = new ThinkTagParser();
		expect(classifyStreamChunk("thought", "pondering", p)).toEqual([
			{ kind: "reasoning", text: "pondering" },
		]);
	});

	it("splits think tags on message kind", () => {
		const p = new ThinkTagParser();
		expect(classifyStreamChunk("message", "<think>t</think>answer", p)).toEqual(
			[
				{ kind: "reasoning", text: "t" },
				{ kind: "text", text: "answer" },
			],
		);
	});
});

describe("promoteOrphanThoughtToText", () => {
	it("promotes sole reasoning part when no text", () => {
		const parts = [
			{ type: "reasoning", id: "r1", text: "This is actually the answer." },
		];
		const out = promoteOrphanThoughtToText(parts);
		expect(out).toEqual([
			{ type: "text", id: "r1", text: "This is actually the answer." },
		]);
	});

	it("promotes only the last reasoning block when several exist", () => {
		const parts = [
			{ type: "reasoning", id: "r1", text: "scratchpad" },
			{ type: "tool", id: "t1" },
			{ type: "reasoning", id: "r2", text: "final body" },
		];
		const out = promoteOrphanThoughtToText(parts);
		expect(out[0]).toMatchObject({ type: "reasoning", text: "scratchpad" });
		expect(out[2]).toMatchObject({ type: "text", text: "final body" });
	});

	it("leaves parts alone when text already present", () => {
		const parts = [
			{ type: "reasoning", id: "r1", text: "think" },
			{ type: "text", id: "a1", text: "answer" },
		];
		expect(promoteOrphanThoughtToText(parts)).toEqual(parts);
	});
});

/** Minimal typed t() stub: keys pass through so assertions stay literal. */
const t = ((key: string) => key) as unknown as TFunction<"agent", undefined>;

function phase(state: AgentPhaseState["phase"], detail?: string) {
	return { phase: state, detail };
}

const toolPart = (title: string, kind = "execute"): AgentPart => ({
	type: "tool",
	id: "p-tool",
	tool: { id: "t1", title, kind, status: "in_progress" },
});

describe("streamingLabel phase priority", () => {
	it("shows the reconnecting label with its attempt detail", () => {
		expect(streamingLabel(phase("reconnecting", "2/5"), [], t)).toBe(
			"streaming.reconnecting 2/5",
		);
	});

	it("drops blank reconnecting detail", () => {
		expect(streamingLabel(phase("reconnecting", "  "), [], t)).toBe(
			"streaming.reconnecting",
		);
		expect(streamingLabel(phase("reconnecting"), [], t)).toBe(
			"streaming.reconnecting",
		);
	});

	it("prefers phases over part-derived activity", () => {
		expect(streamingLabel(phase("waiting-model"), [toolPart("Read")], t)).toBe(
			"streaming.waitingModel",
		);
		expect(streamingLabel(phase("starting"), [toolPart("Read")], t)).toBe(
			"streaming.starting",
		);
	});

	it("prefers waiting-model over starting", () => {
		expect(streamingLabel(phase("waiting-model"), [], t)).toBe(
			"streaming.waitingModel",
		);
	});
});

describe("streamingLabel part fallbacks", () => {
	it("uses the latest non-text tool title", () => {
		const parts: AgentPart[] = [
			{ type: "text", id: "p1", text: "intro" },
			toolPart("terminal: grep"),
			{ type: "text", id: "p2", text: "after" },
		];
		expect(streamingLabel(null, parts, t)).toBe("terminal: grep");
	});

	it("falls back to the tool kind when the title is empty", () => {
		const parts: AgentPart[] = [
			{
				type: "tool",
				id: "p1",
				tool: { id: "t1", title: "", kind: "read", status: "in_progress" },
			},
		];
		expect(streamingLabel(null, parts, t)).toBe("read");
	});

	it("uses the reasoning text, or the placeholder when blank", () => {
		const withText: AgentPart[] = [
			{ type: "reasoning", id: "p1", text: "considering options" },
		];
		expect(streamingLabel(null, withText, t)).toBe("considering options");
		const blank: AgentPart[] = [{ type: "reasoning", id: "p1", text: "  " }];
		expect(streamingLabel(null, blank, t)).toBe("streaming.reasoning");
	});

	it("labels plan parts", () => {
		const parts: AgentPart[] = [
			{
				type: "plan",
				id: "p1",
				entries: [{ content: "step", status: "pending", priority: "medium" }],
			},
		];
		expect(streamingLabel(null, parts, t)).toBe("streaming.plan");
	});

	it("labels the last non-text part even when plain text follows it", () => {
		const parts: AgentPart[] = [
			toolPart("terminal: earlier"),
			{ type: "text", id: "p1", text: "latest text" },
		];
		expect(streamingLabel(null, parts, t)).toBe("terminal: earlier");
	});

	it("falls back to thinking when only text parts exist", () => {
		const parts: AgentPart[] = [{ type: "text", id: "p1", text: "streaming" }];
		expect(streamingLabel(null, parts, t)).toBe("streaming.thinking");
	});

	it("falls back to thinking for empty parts and no phase", () => {
		expect(streamingLabel(null, [], t)).toBe("streaming.thinking");
		expect(streamingLabel(undefined, [], t)).toBe("streaming.thinking");
	});
});
