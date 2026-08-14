import {
	type AgentStreamEvent,
	type AgentToolEvent,
	listenAgentStream,
	listenAgentTool,
} from "@/lib/agent";
import type { DefensePreparationManifest } from "@/lib/voice-defense/preparation/schema";
import { subscribeDefensePreparations } from "@/lib/voice-defense/preparation/state";

/**
 * Live committee reasoning feed for the preparation backdrop.
 *
 * The two analysis workers stream `agent:stream` thought chunks and
 * `agent:tool` actions while they run. This module turns those events into
 * per-role rolling line buffers — memory only, capped, and discarded with the
 * run. Nothing here is persisted; manifests and artifacts stay free of model
 * reasoning by design.
 */

export type ThoughtRole = "paper-analysis" | "adversarial-review";

export type ThoughtLine = {
	/** Monotonic line number — a stable render key across buffer trimming. */
	no: number;
	text: string;
};

export type RoleThoughtBuffer = {
	nextNo: number;
	lines: ThoughtLine[];
};

export type ThoughtStreamState = {
	analysis: ThoughtLine[];
	review: ThoughtLine[];
	lastEventAt: number | null;
};

export const THOUGHT_BUFFER_MAX_LINES = 48;

export function createRoleThoughtBuffer(): RoleThoughtBuffer {
	return { nextNo: 1, lines: [] };
}

function trimmed(
	buffer: RoleThoughtBuffer,
	maxLines: number,
): RoleThoughtBuffer {
	if (buffer.lines.length <= maxLines) return buffer;
	return { ...buffer, lines: buffer.lines.slice(-maxLines) };
}

/** Append streamed thought text, extending the last line until a newline. */
export function appendThoughtText(
	buffer: RoleThoughtBuffer,
	text: string,
	maxLines = THOUGHT_BUFFER_MAX_LINES,
): RoleThoughtBuffer {
	if (!text) return buffer;
	const pieces = text.replace(/\r\n?/g, "\n").split("\n");
	const lines = [...buffer.lines];
	let nextNo = buffer.nextNo;
	if (lines.length === 0) {
		lines.push({ no: nextNo, text: pieces[0] ?? "" });
		nextNo += 1;
	} else {
		const last = lines[lines.length - 1];
		lines[lines.length - 1] = { ...last, text: last.text + (pieces[0] ?? "") };
	}
	for (const piece of pieces.slice(1)) {
		lines.push({ no: nextNo, text: piece });
		nextNo += 1;
	}
	return trimmed({ nextNo, lines }, maxLines);
}

/**
 * Strip the Host snapshot-workspace prefix so tool actions read as
 * Vault-relative paths instead of `/var/folders/…` temp noise.
 */
export function sanitizeActionTitle(title: string): string {
	return title
		.replace(
			/["'`]?\S*agentero-defense-snapshots\/[^/\s]+\/([^\s"'`]*)["'`]?/g,
			"$1",
		)
		.replace(/\s+/g, " ")
		.trim();
}

/** Render-time cleanup: drop markdown emphasis markers from a thought line. */
export function formatThoughtLineText(text: string): string {
	return text.replaceAll("**", "");
}

/** Record a tool action as its own line, deduplicating repeats. */
export function appendActionLine(
	buffer: RoleThoughtBuffer,
	title: string,
	maxLines = THOUGHT_BUFFER_MAX_LINES,
): RoleThoughtBuffer {
	const action = sanitizeActionTitle(title);
	if (!action) return buffer;
	const text = `› ${action}`;
	const lastContent = [...buffer.lines]
		.reverse()
		.find((line) => line.text.trim());
	if (lastContent?.text === text) return buffer;
	const lines = [...buffer.lines];
	let nextNo = buffer.nextNo;
	// Close an unfinished thought line so the action stands on its own row.
	if (lines.length > 0 && lines[lines.length - 1]?.text.trim() === "") {
		lines.pop();
	}
	lines.push({ no: nextNo, text });
	nextNo += 1;
	lines.push({ no: nextNo, text: "" });
	nextNo += 1;
	return trimmed({ nextNo, lines }, maxLines);
}

/** Map live ACP session ids to committee roles from the run manifest. */
export function sessionRoleMap(
	manifest: DefensePreparationManifest | null,
): Map<string, ThoughtRole> {
	const map = new Map<string, ThoughtRole>();
	if (!manifest) return map;
	for (const role of ["paper-analysis", "adversarial-review"] as const) {
		for (const attempt of manifest.nodes[role].attempts) {
			if (attempt.sessionId) map.set(attempt.sessionId, role);
		}
	}
	return map;
}

export type ThoughtStreamDeps = {
	listenStream: typeof listenAgentStream;
	listenTool: typeof listenAgentTool;
	subscribePreparations: typeof subscribeDefensePreparations;
	now: () => number;
};

function defaultDeps(): ThoughtStreamDeps {
	return {
		listenStream: listenAgentStream,
		listenTool: listenAgentTool,
		subscribePreparations: subscribeDefensePreparations,
		now: Date.now,
	};
}

/**
 * Watch one preparation run and emit throttled thought-stream snapshots.
 * Returns a dispose function; all buffers live and die in memory.
 */
export function watchCommitteeThoughts(
	input: {
		runId: string;
		onUpdate: (state: ThoughtStreamState) => void;
		throttleMs?: number;
	},
	deps: Partial<ThoughtStreamDeps> = {},
): () => void {
	const resolved = { ...defaultDeps(), ...deps };
	const throttleMs = input.throttleMs ?? 160;
	const buffers: Record<ThoughtRole, RoleThoughtBuffer> = {
		"paper-analysis": createRoleThoughtBuffer(),
		"adversarial-review": createRoleThoughtBuffer(),
	};
	let roles = new Map<string, ThoughtRole>();
	let lastEventAt: number | null = null;
	let disposed = false;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	const flush = () => {
		flushTimer = null;
		if (disposed) return;
		input.onUpdate({
			analysis: [...buffers["paper-analysis"].lines],
			review: [...buffers["adversarial-review"].lines],
			lastEventAt,
		});
	};
	const scheduleFlush = () => {
		if (disposed || flushTimer !== null) return;
		flushTimer = setTimeout(flush, throttleMs);
	};

	const unsubscribePreparations = resolved.subscribePreparations((states) => {
		const state = states.find((item) => item.runId === input.runId);
		if (state?.manifest) roles = sessionRoleMap(state.manifest);
	});

	const listeners: Array<() => void> = [];
	const register = (listen: Promise<() => void>) => {
		void listen.then((unlisten) => {
			if (disposed) unlisten();
			else listeners.push(unlisten);
		});
	};
	register(
		resolved.listenStream((event: AgentStreamEvent) => {
			if (event.kind !== "thought") return;
			const role = roles.get(event.sessionId);
			if (!role || !event.chunk) return;
			buffers[role] = appendThoughtText(buffers[role], event.chunk);
			lastEventAt = resolved.now();
			scheduleFlush();
		}),
	);
	register(
		resolved.listenTool((event: AgentToolEvent) => {
			const role = roles.get(event.sessionId);
			const title = event.title?.trim();
			if (!role || !title || event.status === "failed") return;
			buffers[role] = appendActionLine(buffers[role], title);
			lastEventAt = resolved.now();
			scheduleFlush();
		}),
	);

	return () => {
		if (disposed) return;
		disposed = true;
		if (flushTimer !== null) clearTimeout(flushTimer);
		unsubscribePreparations();
		for (const unlisten of listeners.splice(0)) unlisten();
	};
}
