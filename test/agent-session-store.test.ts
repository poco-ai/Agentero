import { beforeEach, describe, expect, it } from "vitest";

import {
	agentSessionStore,
	applyAgentSessionHandoff,
	applyAgentSessionHandoffOnce,
	EMPTY_CHAT_LINES,
	resetAgentSessionHandoffApplied,
} from "@/lib/agent/agent-session-store";
import {
	shouldScheduleAgentSessionHandoff,
	stepHandoffDelivery,
} from "@/lib/agent/session-handoff";

beforeEach(() => {
	resetAgentSessionHandoffApplied();
	agentSessionStore.setState({
		sessions: [],
		activeTabId: "draft",
		hydratingSessionId: null,
		draftLines: EMPTY_CHAT_LINES,
		permissionRequest: null,
		handoff: null,
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

describe("applyAgentSessionHandoffOnce", () => {
	const runningSession = {
		id: "local-1",
		agentId: "codex",
		source: "local" as const,
		title: "in flight",
		agentName: "Codex",
		startedAt: "",
		lines: [{ id: "u1", kind: "user" as const, text: "hello" }],
		status: "running" as const,
		providerSessionId: "provider-1",
	};

	it("applies the snapshot once and keeps later transcript writes", () => {
		const first = applyAgentSessionHandoffOnce({
			sessions: [runningSession],
			activeTabId: "local-1",
			draftLines: [],
			deliveryId: "d1",
			sourceLabel: "main",
			targetLabel: "feature-agent",
			providerSessionId: "provider-1",
			localSessionId: "local-1",
			agentId: "codex",
			running: true,
			composerText: "unsent",
			mentions: ["papers/a"],
			composerSkillIds: ["skill-a"],
			includeSelectedFile: true,
			images: [{ data: "YWJj", mimeType: "image/png" }],
			visualRefs: [],
			queue: [
				{
					id: "q1",
					text: "next",
					contextPaths: [],
					skillIds: [],
					selections: [],
					visualDrafts: [],
				},
			],
			permissionRequestId: "perm-1",
			elicitationRequestId: "elicit-1",
			askUserRequestId: null,
			permissionRequest: {
				requestId: "perm-1",
				sessionId: "local-1",
				title: "Read file",
				paths: ["notes/a.md"],
				options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
			},
			elicitationRequest: {
				requestId: "elicit-1",
				sessionId: "local-1",
				message: "Which section?",
				fields: [],
			},
			askUserRequest: null,
		});
		expect(first).toBe(true);

		agentSessionStore
			.getState()
			.updateSessionLines("local-1", (lines) => [
				...lines,
				{ id: "a1", kind: "agent", parts: [], streaming: true },
			]);

		const second = applyAgentSessionHandoffOnce({
			sessions: [{ ...runningSession, lines: [], status: "completed" }],
			activeTabId: "local-1",
			composerText: "stale",
			running: false,
		});
		expect(second).toBe(false);

		const state = agentSessionStore.getState();
		expect(state.sessions[0]?.lines.map((line) => line.id)).toEqual([
			"u1",
			"a1",
		]);
		expect(state.sessions[0]?.status).toBe("running");
		expect(state.handoff?.running).toBe(true);
		expect(state.handoff?.composerText).toBe("unsent");
		expect(state.handoff?.mentions).toEqual(["papers/a"]);
		expect(state.handoff?.providerSessionId).toBe("provider-1");
		expect(state.handoff?.localSessionId).toBe("local-1");
		expect(state.handoff?.queue).toHaveLength(1);
		expect(state.permissionRequest?.requestId).toBe("perm-1");
		expect(state.handoff?.elicitationRequestId).toBe("elicit-1");
		expect(state.handoff?.askUserRequestId).toBeNull();
		expect("runningSessionIds" in state).toBe(false);
	});

	it("derives running from the session row, not the payload flag", () => {
		applyAgentSessionHandoff({
			sessions: [{ ...runningSession, status: "completed" }],
			activeTabId: "local-1",
			running: true,
		});
		expect(agentSessionStore.getState().handoff?.running).toBe(false);
		expect(agentSessionStore.getState().sessions[0]?.status).toBe("completed");
	});
});

describe("agent session handoff delivery", () => {
	it("does not schedule a snapshot onto an agent window that is already open", () => {
		expect(shouldScheduleAgentSessionHandoff("agent", true)).toBe(false);
		expect(shouldScheduleAgentSessionHandoff("agent", false)).toBe(true);
		expect(shouldScheduleAgentSessionHandoff("annotations", false)).toBe(false);
	});

	it("sends the snapshot once and rebinds only after ack", () => {
		const expected = {
			targetLabel: "feature-agent",
			deliveryId: "d1",
		};
		const ready = stepHandoffDelivery(
			"waiting-ready",
			{ kind: "ready", targetLabel: "feature-agent" },
			expected,
		);
		expect(ready).toEqual({ phase: "snapshot-sent", effect: "send-snapshot" });

		const readyAgain = stepHandoffDelivery(
			ready.phase,
			{ kind: "ready", targetLabel: "feature-agent" },
			expected,
		);
		expect(readyAgain.effect).toBe("none");

		const earlyAck = stepHandoffDelivery(
			"waiting-ready",
			{
				kind: "ack",
				targetLabel: "feature-agent",
				sourceLabel: "main",
				deliveryId: "d1",
			},
			expected,
		);
		expect(earlyAck).toEqual({ phase: "waiting-ready", effect: "none" });

		const ack = stepHandoffDelivery(
			"snapshot-sent",
			{
				kind: "ack",
				targetLabel: "feature-agent",
				sourceLabel: "main",
				deliveryId: "d1",
			},
			expected,
		);
		expect(ack).toEqual({ phase: "delivered", effect: "rebind" });

		const ackAgain = stepHandoffDelivery(
			ack.phase,
			{
				kind: "ack",
				targetLabel: "feature-agent",
				sourceLabel: "main",
				deliveryId: "d1",
			},
			expected,
		);
		expect(ackAgain.effect).toBe("none");
	});
});
