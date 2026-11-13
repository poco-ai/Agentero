import { beforeEach, describe, expect, it } from "vitest";
import { agentChromeStore } from "@/lib/agent/agent-chrome-store";
import {
	type AgentSessionRecord,
	agentSessionStore,
	EMPTY_CHAT_LINES,
} from "@/lib/agent/agent-session-store";
import {
	closeZenWorkspace,
	seedZenFromRail,
	zenStore,
} from "@/lib/agent/zen-store";

function session(
	id: string,
	overrides: Partial<AgentSessionRecord> = {},
): AgentSessionRecord {
	return {
		id,
		agentId: "agent-1",
		source: "local",
		title: id,
		agentName: "Agent",
		startedAt: "",
		lines: [],
		status: "completed",
		...overrides,
	};
}

beforeEach(() => {
	closeZenWorkspace();
	agentSessionStore.setState({
		sessions: [],
		activeTabId: "draft",
		hydratingSessionId: null,
		draftLines: EMPTY_CHAT_LINES,
	});
	agentChromeStore.setState({ agentId: null, name: null, template: null });
});

describe("zen slots", () => {
	it("activates the newest slot and falls back to a neighbor on close", () => {
		const first = zenStore.getState().addSlot();
		const second = zenStore.getState().addSlot();
		expect(zenStore.getState().activeSlotId).toBe(second);

		zenStore.getState().activateSlot(first);
		expect(zenStore.getState().activeSlotId).toBe(first);

		zenStore.getState().removeSlot(first);
		expect(zenStore.getState().slots.map((slot) => slot.id)).toEqual([second]);
		expect(zenStore.getState().activeSlotId).toBe(second);
	});

	it("starts a harness slot with a pending history row", () => {
		const id = zenStore.getState().addSlot({
			agentId: "agent-2",
			agentName: "Codex",
			agentTemplate: "codex-acp",
			history: {
				id: "ses-1",
				agentId: "agent-2",
				agentName: "Codex",
				title: "Past chat",
				startedAt: "",
				providerSessionId: "ses-1",
			},
		});
		const slot = zenStore.getState().slots.find((item) => item.id === id);
		expect(slot?.agent).toEqual({
			id: "agent-2",
			name: "Codex",
			template: "codex-acp",
		});
		expect(slot?.pendingHistory?.id).toBe("ses-1");

		zenStore.getState().clearSlotHistory(id);
		expect(
			zenStore.getState().slots.find((item) => item.id === id)?.pendingHistory,
		).toBeNull();
	});

	it("reports the harness chosen inside a slot", () => {
		const id = zenStore.getState().addSlot();
		zenStore.getState().setSlotAgent(id, {
			id: "agent-2",
			name: "Codex",
			template: "codex-acp",
		});
		expect(zenStore.getState().slots[0]?.agent).toEqual({
			id: "agent-2",
			name: "Codex",
			template: "codex-acp",
		});
	});
});

describe("rail takeover", () => {
	it("copies ordinary sessions and leaves the rail store intact", () => {
		const chat = session("chat-1");
		const pin = session("pin-1", { visualTraceId: "trace-1" });
		agentSessionStore.setState({
			sessions: [chat, pin],
			activeTabId: "chat-1",
		});
		agentChromeStore.setState({
			agentId: "agent-1",
			name: "Agent",
			template: "opencode",
		});

		seedZenFromRail(null);

		const [slot] = zenStore.getState().slots;
		expect(slot).toBeDefined();
		if (!slot) return;
		const zenState = slot.store.getState();
		expect(zenState.sessions.map((item) => item.id)).toEqual(["chat-1"]);
		expect(zenState.activeTabId).toBe("chat-1");
		expect(slot.agent.id).toBe("agent-1");
		// The rail keeps its own copy (pin sessions included).
		expect(agentSessionStore.getState().sessions).toHaveLength(2);
	});

	it("starts a draft when the rail's active tab was a pin chat", () => {
		agentSessionStore.setState({
			sessions: [session("pin-1", { visualTraceId: "trace-1" })],
			activeTabId: "pin-1",
		});

		seedZenFromRail(null);

		const [slot] = zenStore.getState().slots;
		expect(slot?.store.getState().activeTabId).toBe("draft");
		expect(slot?.store.getState().sessions).toEqual([]);
	});

	it("only seeds once", () => {
		agentSessionStore.setState({
			sessions: [session("chat-1")],
			activeTabId: "chat-1",
		});
		seedZenFromRail(null);
		seedZenFromRail(null);
		expect(zenStore.getState().slots).toHaveLength(1);
	});
});
