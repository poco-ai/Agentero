import { describe, expect, it } from "vitest";
import type { AgentStreamEvent, AgentToolEvent } from "../src/lib/agent/api";
import type {
	DefensePreparationManifest,
	PaperSnapshot,
} from "../src/lib/voice-defense/preparation/schema";
import { DEFENSE_PREPARATION_SCHEMA_VERSION } from "../src/lib/voice-defense/preparation/schema";
import type { DefensePreparationRuntimeState } from "../src/lib/voice-defense/preparation/state";
import {
	createDefensePreparationManifest,
	startNodeAttempt,
} from "../src/lib/voice-defense/preparation/state";
import {
	appendActionLine,
	appendThoughtText,
	createRoleThoughtBuffer,
	formatThoughtLineText,
	sanitizeActionTitle,
	sessionRoleMap,
	type ThoughtStreamState,
	watchCommitteeThoughts,
} from "../src/lib/voice-defense/thought-stream";

function snapshot(): PaperSnapshot {
	return {
		schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
		paperPath: "papers/demo",
		materials: [{ path: "papers/demo", kind: "directory" }],
		instruction: "",
		metadata: {},
		selections: [],
		sources: [],
		snapshotSha256: "snapshot-hash",
		warnings: [],
		createdAt: "2026-08-13T00:00:00.000Z",
	};
}

function manifestWithSessions(): DefensePreparationManifest {
	const manifest = createDefensePreparationManifest({
		runId: "run-1",
		snapshot: snapshot(),
		now: "2026-08-13T00:00:00.000Z",
	});
	startNodeAttempt(manifest, "paper-analysis", {
		attempt: 1,
		startedAt: "2026-08-13T00:00:01.000Z",
	}).sessionId = "session-analysis";
	startNodeAttempt(manifest, "adversarial-review", {
		attempt: 1,
		startedAt: "2026-08-13T00:00:01.000Z",
	}).sessionId = "session-review";
	return manifest;
}

function runtimeState(
	manifest: DefensePreparationManifest,
): DefensePreparationRuntimeState {
	return {
		runId: manifest.runId,
		vaultRoot: "/vault",
		paperPath: manifest.paperPath,
		manifest,
		activeChildSessionIds: ["session-analysis", "session-review"],
		cancelRequested: false,
		startedAt: "2026-08-13T00:00:01.000Z",
	};
}

async function flushTimers(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("thought buffers", () => {
	it("appends streamed text to the last line and splits on newlines", () => {
		let buffer = createRoleThoughtBuffer();
		buffer = appendThoughtText(buffer, "checking the ");
		buffer = appendThoughtText(buffer, "baselines\nnow the ablations");
		expect(buffer.lines.map((line) => line.text)).toEqual([
			"checking the baselines",
			"now the ablations",
		]);
		expect(buffer.lines.map((line) => line.no)).toEqual([1, 2]);
	});

	it("caps the buffer while keeping line numbers stable", () => {
		let buffer = createRoleThoughtBuffer();
		buffer = appendThoughtText(buffer, "a\nb\nc\nd", 2);
		expect(buffer.lines.map((line) => line.text)).toEqual(["c", "d"]);
		expect(buffer.lines.map((line) => line.no)).toEqual([3, 4]);
		buffer = appendThoughtText(buffer, "\ne", 2);
		expect(buffer.lines.map((line) => line.text)).toEqual(["d", "e"]);
	});

	it("records tool actions once and keeps them on their own line", () => {
		let buffer = createRoleThoughtBuffer();
		buffer = appendThoughtText(buffer, "reading the paper\n");
		buffer = appendActionLine(buffer, "Read papers/demo/PAPER.md");
		buffer = appendActionLine(buffer, "Read papers/demo/PAPER.md");
		expect(
			buffer.lines.filter((line) => line.text.startsWith("›")),
		).toHaveLength(1);
		expect(buffer.lines.at(-2)?.text).toBe("› Read papers/demo/PAPER.md");
		expect(buffer.lines.at(-1)?.text).toBe("");
	});

	it("rewrites snapshot-workspace paths back to Vault-relative form", () => {
		expect(
			sanitizeActionTitle(
				"Read file '/var/folders/t8/161bn0_x/T/agentero-defense-snapshots/c022fe90-1ece/papers/demo/PAPER.md'",
			),
		).toBe("Read file papers/demo/PAPER.md");
		expect(sanitizeActionTitle("Read papers/demo/NOTES.md")).toBe(
			"Read papers/demo/NOTES.md",
		);
		const buffer = appendActionLine(
			createRoleThoughtBuffer(),
			"Read '/tmp/agentero-defense-snapshots/run-1/papers/demo/PAPER.md'",
		);
		expect(buffer.lines[0]?.text).toBe("› Read papers/demo/PAPER.md");
	});

	it("drops markdown emphasis markers at render time", () => {
		expect(formatThoughtLineText("**Planning file inspection**")).toBe(
			"Planning file inspection",
		);
		expect(formatThoughtLineText("plain text")).toBe("plain text");
	});

	it("maps live session ids to committee roles from the manifest", () => {
		const roles = sessionRoleMap(manifestWithSessions());
		expect(roles.get("session-analysis")).toBe("paper-analysis");
		expect(roles.get("session-review")).toBe("adversarial-review");
		expect(sessionRoleMap(null).size).toBe(0);
	});
});

describe("watchCommitteeThoughts", () => {
	function createHarness() {
		const streamHandlers: Array<(event: AgentStreamEvent) => void> = [];
		const toolHandlers: Array<(event: AgentToolEvent) => void> = [];
		const unlistened: string[] = [];
		let emitRuntime:
			| ((states: readonly DefensePreparationRuntimeState[]) => void)
			| null = null;
		const updates: ThoughtStreamState[] = [];
		const dispose = watchCommitteeThoughts(
			{
				runId: "run-1",
				onUpdate: (state) => updates.push(state),
				throttleMs: 0,
			},
			{
				listenStream: (handler) => {
					streamHandlers.push(handler);
					return Promise.resolve(() => unlistened.push("stream"));
				},
				listenTool: (handler) => {
					toolHandlers.push(handler);
					return Promise.resolve(() => unlistened.push("tool"));
				},
				subscribePreparations: (subscriber) => {
					emitRuntime = subscriber;
					subscriber([]);
					return () => unlistened.push("preparations");
				},
				now: () => 12_345,
			},
		);
		emitRuntime?.([runtimeState(manifestWithSessions())]);
		return { streamHandlers, toolHandlers, unlistened, updates, dispose };
	}

	it("routes thought chunks and tool actions to the right committee", async () => {
		const harness = createHarness();
		harness.streamHandlers[0]?.({
			sessionId: "session-analysis",
			chunk: "mapping the method section",
			kind: "thought",
		});
		harness.toolHandlers[0]?.({
			sessionId: "session-review",
			toolCallId: "tool-1",
			title: "Read papers/demo/PAPER.md",
			status: "in_progress",
		});
		await flushTimers();

		const latest = harness.updates.at(-1);
		expect(latest?.analysis.map((line) => line.text)).toEqual([
			"mapping the method section",
		]);
		expect(latest?.review[0]?.text).toBe("› Read papers/demo/PAPER.md");
		expect(latest?.lastEventAt).toBe(12_345);
		harness.dispose();
	});

	it("ignores message chunks, unknown sessions, and failed tools", async () => {
		const harness = createHarness();
		harness.streamHandlers[0]?.({
			sessionId: "session-analysis",
			chunk: '{"partial":"json"}',
			kind: "message",
		});
		harness.streamHandlers[0]?.({
			sessionId: "other-session",
			chunk: "stray thought",
			kind: "thought",
		});
		harness.toolHandlers[0]?.({
			sessionId: "session-review",
			toolCallId: "tool-1",
			title: "Broken tool",
			status: "failed",
		});
		await flushTimers();
		expect(harness.updates).toHaveLength(0);
		harness.dispose();
	});

	it("stops updating and unlistens after dispose", async () => {
		const harness = createHarness();
		harness.streamHandlers[0]?.({
			sessionId: "session-analysis",
			chunk: "first",
			kind: "thought",
		});
		await flushTimers();
		const count = harness.updates.length;
		harness.dispose();
		await flushTimers();
		harness.streamHandlers[0]?.({
			sessionId: "session-analysis",
			chunk: "second",
			kind: "thought",
		});
		await flushTimers();
		expect(harness.updates).toHaveLength(count);
		expect(harness.unlistened).toEqual(
			expect.arrayContaining(["preparations", "stream", "tool"]),
		);
		harness.dispose();
	});
});
