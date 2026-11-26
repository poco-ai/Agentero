import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionRecord } from "@/lib/agent/agent-session-store";
import { closeZenWorkspace, zenStore } from "@/lib/agent/zen-store";

function session(id: string): AgentSessionRecord {
	return {
		id,
		agentId: "agent-1",
		source: "local",
		title: id,
		agentName: "Agent",
		startedAt: "",
		lines: [],
		status: "completed",
	};
}

beforeEach(closeZenWorkspace);

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

	it("closes one session and keeps the slot's other sessions", () => {
		const id = zenStore.getState().addSlot({
			sessions: [session("chat-1"), session("chat-2")],
			activeTabId: "chat-2",
		});

		zenStore.getState().closeSlotSession(id, "chat-2");

		const slot = zenStore.getState().slots.find((item) => item.id === id);
		expect(slot?.store.getState().sessions.map((item) => item.id)).toEqual([
			"chat-1",
		]);
		expect(slot?.store.getState().activeTabId).toBe("chat-1");
	});

	it("drops the slot with its last session", () => {
		const id = zenStore.getState().addSlot({
			sessions: [session("chat-1")],
			activeTabId: "chat-1",
		});

		zenStore.getState().closeSlotSession(id, "chat-1");

		expect(zenStore.getState().slots).toHaveLength(0);
	});
});
