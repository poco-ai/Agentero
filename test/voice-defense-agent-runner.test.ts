import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import {
	createDefaultAgentRunner,
	type PreparationAgentRunInput,
} from "@/lib/voice-defense/preparation/coordinator";

const agentApi = vi.hoisted(() => ({
	runOnce: vi.fn(),
	cancelAgentRun: vi.fn(),
	isAgentRunActive: vi.fn(),
	listenAgentCompleted: vi.fn(),
	listenAgentFailed: vi.fn(),
	listenAgentUsage: vi.fn(),
}));

vi.mock("@/lib/agent", () => agentApi);

function input(signal: AbortSignal): PreparationAgentRunInput {
	return {
		vaultRoot: "/vault",
		role: "paper-analysis",
		prompt: "analyze",
		request: {
			workflow: "voice_defense_preparation",
			permissionMode: "restricted",
			autoApprove: false,
			hideFromChatHistory: true,
		},
		target: "papers/demo",
		signal,
		onStarted: vi.fn(),
		onFinished: vi.fn(),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	agentApi.listenAgentCompleted.mockResolvedValue(vi.fn());
	agentApi.listenAgentFailed.mockResolvedValue(vi.fn());
	agentApi.listenAgentUsage.mockResolvedValue(vi.fn());
	agentApi.cancelAgentRun.mockResolvedValue(undefined);
	agentApi.isAgentRunActive.mockResolvedValue(false);
});

describe("default preparation ACP runner", () => {
	it("turns a terminal wait timeout into a retryable error", async () => {
		agentApi.runOnce.mockResolvedValue({
			sessionId: "session-timeout",
			messageId: "message-timeout",
			agentId: "agent",
		});
		const runner = createDefaultAgentRunner(agentApi.isAgentRunActive, 10);
		const controller = new AbortController();
		const runInput = input(controller.signal);
		const promise = runner(runInput);
		const rejection = expect(promise).rejects.toThrow(
			"ACP node timed out after 10ms",
		);

		await vi.advanceTimersByTimeAsync(10);
		await rejection;
		expect(agentApi.cancelAgentRun).toHaveBeenCalledWith("session-timeout");
		expect(agentApi.isAgentRunActive).toHaveBeenCalledWith("session-timeout");
		expect(runInput.onFinished).toHaveBeenCalledWith("session-timeout");
	});

	it("uses one timeout budget across ACP acceptance and terminal wait", async () => {
		agentApi.runOnce.mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(
						() =>
							resolve({
								sessionId: "session-budget",
								messageId: "message-budget",
								agentId: "agent",
							}),
						7,
					);
				}),
		);
		const runner = createDefaultAgentRunner(agentApi.isAgentRunActive, 10);
		const controller = new AbortController();
		const promise = runner(input(controller.signal));
		const rejection = expect(promise).rejects.toThrow(
			"ACP node timed out after 10ms",
		);

		await vi.advanceTimersByTimeAsync(7);
		expect(agentApi.cancelAgentRun).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2);
		expect(agentApi.cancelAgentRun).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
		expect(agentApi.cancelAgentRun).toHaveBeenCalledWith("session-budget");
	});

	it("cancels an already-aborted input without waiting for node timeout", async () => {
		agentApi.runOnce.mockResolvedValue({
			sessionId: "session-cancelled",
			messageId: "message-cancelled",
			agentId: "agent",
		});
		const runner = createDefaultAgentRunner(agentApi.isAgentRunActive, 10_000);
		const controller = new AbortController();
		controller.abort();
		const runInput = input(controller.signal);
		const promise = runner(runInput);

		await expect(promise).rejects.toBeInstanceOf(BackgroundTaskCancelledError);
		expect(agentApi.cancelAgentRun).toHaveBeenCalledWith("session-cancelled");
		expect(runInput.onFinished).toHaveBeenCalledWith("session-cancelled");
	});
});
