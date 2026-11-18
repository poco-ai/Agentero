import { beforeEach, describe, expect, it } from "vitest";

import {
	agentSessionStore,
	EMPTY_CHAT_LINES,
} from "@/lib/agent/agent-session-store";

beforeEach(() => {
	agentSessionStore.setState({
		sessions: [],
		activeTabId: "draft",
		hydratingSessionId: null,
		draftLines: EMPTY_CHAT_LINES,
		permissionRequest: null,
		turnRequest: null,
	});
});

describe("startDraft", () => {
	it("keeps the completed conversation transcript when starting a new chat", () => {
		const lines = [{ id: "u1", kind: "user" as const, text: "hello" }];
		agentSessionStore.getState().upsertSession({
			id: "runtime-v4",
			agentId: "codex",
			source: "local",
			title: "hello",
			agentName: "Codex",
			startedAt: "",
			lines,
			status: "completed",
			providerSessionId: "provider-v7",
		});

		agentSessionStore.getState().startDraft();

		const state = agentSessionStore.getState();
		expect(state.activeTabId).toBe("draft");
		expect(state.draftLines).toBe(EMPTY_CHAT_LINES);
		expect(state.sessions[0]?.lines).toEqual(lines);
	});

	it("clears a pending history hydration marker", () => {
		agentSessionStore.setState({ hydratingSessionId: "provider-v7" });

		agentSessionStore.getState().startDraft();

		expect(agentSessionStore.getState().hydratingSessionId).toBeNull();
	});
});

describe("updateSessionLines", () => {
	const seedSession = () => {
		const lines = [
			{ id: "u1", kind: "user" as const, text: "question" },
			{ id: "sys1", kind: "system" as const, text: "checkpoint" },
			{
				id: "a1",
				kind: "agent" as const,
				parts: [{ type: "text" as const, id: "t1", text: "partial" }],
				streaming: true,
			},
		];
		agentSessionStore.getState().upsertSession({
			id: "runtime-v4",
			agentId: "codex",
			source: "local",
			title: "question",
			agentName: "Codex",
			startedAt: "",
			lines,
			status: "running",
		});
		return lines;
	};

	it("keeps unchanged line references stable when streaming patches the last line", () => {
		seedSession();
		const before = agentSessionStore.getState().sessions[0].lines;

		// Same shape as applyStreamEvent: copy the array, replace only the tail.
		agentSessionStore.getState().updateSessionLines("runtime-v4", (prev) => {
			const next = [...prev];
			const last = next[next.length - 1];
			if (last?.kind !== "agent") return prev;
			next[next.length - 1] = {
				...last,
				parts: [{ type: "text", id: "t1", text: "partial + chunk" }],
			};
			return next;
		});

		const after = agentSessionStore.getState().sessions[0].lines;
		expect(after).not.toBe(before);
		// Memoized transcript rows bail out on these reference-equal lines.
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBe(before[1]);
		expect(after[2]).not.toBe(before[2]);
	});

	it("does not publish a new sessions array when the updater returns prev", () => {
		seedSession();
		const before = agentSessionStore.getState().sessions;

		agentSessionStore
			.getState()
			.updateSessionLines("runtime-v4", (prev) => prev);

		expect(agentSessionStore.getState().sessions).toBe(before);
	});

	it("keeps sibling session records untouched by reference", () => {
		seedSession();
		agentSessionStore.getState().upsertSession(
			{
				id: "other-session",
				agentId: "codex",
				source: "local",
				title: "other",
				agentName: "Codex",
				startedAt: "",
				lines: [{ id: "u9", kind: "user" as const, text: "hi" }],
				status: "completed",
			},
			{ activate: false },
		);
		const otherBefore = agentSessionStore
			.getState()
			.sessions.find((s) => s.id === "other-session");

		agentSessionStore
			.getState()
			.updateSessionLines("runtime-v4", (prev) => [...prev]);

		const otherAfter = agentSessionStore
			.getState()
			.sessions.find((s) => s.id === "other-session");
		expect(otherAfter).toBe(otherBefore);
	});
});

describe("hydrateAndActivateSession", () => {
	it("publishes a loaded transcript and activation in one store update", () => {
		const historyItem = {
			id: "provider-v7",
			agentId: "codex",
			source: "external" as const,
			title: "Indexed title",
			agentName: "Codex",
			startedAt: "",
			lines: [],
			status: "completed" as const,
			providerSessionId: "provider-v7",
		};
		const loadedLines = [
			{ id: "u1", kind: "user" as const, text: "Earlier question" },
		];
		agentSessionStore.setState({
			sessions: [historyItem],
			activeTabId: "draft",
			hydratingSessionId: historyItem.id,
			draftLines: [
				{ id: "draft-u1", kind: "user" as const, text: "Unsaved draft" },
			],
		});

		agentSessionStore
			.getState()
			.hydrateAndActivateSession(historyItem, loadedLines, "Earlier question");

		const state = agentSessionStore.getState();
		expect(state.activeTabId).toBe(historyItem.id);
		expect(state.hydratingSessionId).toBeNull();
		expect(state.draftLines).toBe(EMPTY_CHAT_LINES);
		expect(state.sessions[0]).toMatchObject({
			id: historyItem.id,
			title: "Earlier question",
			lines: loadedLines,
		});
	});

	it("restores the selected item if a concurrent history refresh removed it", () => {
		const historyItem = {
			id: "provider-v7",
			agentId: "codex",
			source: "external" as const,
			title: "Earlier conversation",
			agentName: "Codex",
			startedAt: "",
			lines: [],
			status: "completed" as const,
			providerSessionId: "provider-v7",
		};
		const loadedLines = [
			{ id: "u1", kind: "user" as const, text: "Earlier question" },
		];

		agentSessionStore
			.getState()
			.hydrateAndActivateSession(historyItem, loadedLines);

		const state = agentSessionStore.getState();
		expect(state.activeTabId).toBe(historyItem.id);
		expect(state.sessions).toEqual([{ ...historyItem, lines: loadedLines }]);
	});
});
