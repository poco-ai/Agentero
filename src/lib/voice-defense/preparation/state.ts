import {
	DEFENSE_PREPARATION_SCHEMA_VERSION,
	type DefenseNodeAttempt,
	type DefenseNodeStatus,
	type DefensePreparationManifest,
	type DefensePreparationRole,
	type DefensePreparationStatus,
	type PaperSnapshot,
} from "@/lib/voice-defense/preparation/schema";

const ROLES: DefensePreparationRole[] = [
	"paper-analysis",
	"adversarial-review",
	"synthesis",
];

export function createDefensePreparationManifest(input: {
	runId: string;
	snapshot: PaperSnapshot;
	now: string;
}): DefensePreparationManifest {
	const node = (role: DefensePreparationRole) => ({
		taskId: `${input.runId}-${role}`,
		role,
		status: "pending" as const,
		attempts: [],
	});
	return {
		schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
		runId: input.runId,
		paperPath: input.snapshot.paperPath,
		status: "created",
		stale: false,
		partial: false,
		snapshot: input.snapshot,
		nodes: {
			"paper-analysis": node("paper-analysis"),
			"adversarial-review": node("adversarial-review"),
			synthesis: node("synthesis"),
		},
		warnings: [...input.snapshot.warnings],
		createdAt: input.now,
		updatedAt: input.now,
	};
}

export function setPreparationStatus(
	manifest: DefensePreparationManifest,
	status: DefensePreparationStatus,
	now: string,
): void {
	manifest.status = status;
	manifest.updatedAt = now;
}

export function startNodeAttempt(
	manifest: DefensePreparationManifest,
	role: DefensePreparationRole,
	input: { attempt: number; startedAt: string },
): DefenseNodeAttempt {
	const node = manifest.nodes[role];
	if (node.attempts.some((attempt) => attempt.attempt === input.attempt)) {
		throw new Error(`${role} attempt ${input.attempt} already exists`);
	}
	const attempt: DefenseNodeAttempt = {
		attempt: input.attempt,
		status: "running",
		startedAt: input.startedAt,
	};
	node.attempts.push(attempt);
	node.status = "running";
	manifest.updatedAt = input.startedAt;
	return attempt;
}

export function finishNodeAttempt(
	manifest: DefensePreparationManifest,
	role: DefensePreparationRole,
	attemptNumber: number,
	input: {
		status: Extract<DefenseNodeStatus, "succeeded" | "failed" | "cancelled">;
		finishedAt: string;
		agentId?: string;
		modelId?: string;
		reasoningEffort?: string;
		sessionId?: string;
		providerSessionId?: string;
		artifactId?: string;
		artifactPath?: string;
		error?: string;
		stopReason?: string;
		usageUsed?: number;
		usageSize?: number;
	},
): void {
	const node = manifest.nodes[role];
	const attempt = node.attempts.find((item) => item.attempt === attemptNumber);
	if (!attempt) throw new Error(`${role} attempt ${attemptNumber} is missing`);
	if (attempt.status !== "running") {
		throw new Error(`${role} attempt ${attemptNumber} is already terminal`);
	}
	Object.assign(attempt, input);
	node.status = input.status;
	if (input.status === "succeeded") {
		node.artifactId = input.artifactId;
		node.artifactPath = input.artifactPath;
	}
	manifest.updatedAt = input.finishedAt;
}

export function nextNodeAttempt(
	manifest: DefensePreparationManifest,
	role: DefensePreparationRole,
): number {
	return (
		manifest.nodes[role].attempts.reduce(
			(maximum, attempt) => Math.max(maximum, attempt.attempt),
			0,
		) + 1
	);
}

export function successfulAnalysisRoles(
	manifest: DefensePreparationManifest,
): Array<"paper-analysis" | "adversarial-review"> {
	return (["paper-analysis", "adversarial-review"] as const).filter(
		(role) => manifest.nodes[role].status === "succeeded",
	);
}

/** Convert interrupted in-memory work into recoverable terminal attempts. */
export function reconcileInterruptedPreparation(
	manifest: DefensePreparationManifest,
	now: string,
): DefensePreparationManifest {
	const recovered = structuredClone(manifest);
	for (const role of ROLES) {
		const node = recovered.nodes[role];
		let running: DefenseNodeAttempt | undefined;
		for (let index = node.attempts.length - 1; index >= 0; index -= 1) {
			if (node.attempts[index]?.status === "running") {
				running = node.attempts[index];
				break;
			}
		}
		if (running) {
			running.status = "failed";
			running.finishedAt = now;
			running.error = "application stopped before the ACP node completed";
			node.status = "failed";
		}
	}
	recovered.updatedAt = now;
	return recovered;
}

export type DefensePreparationRuntimeState = {
	runId: string;
	vaultRoot: string;
	paperPath: string;
	manifest: DefensePreparationManifest | null;
	activeChildSessionIds: string[];
	backgroundTaskId?: string;
	cancelRequested: boolean;
	startedAt: string;
};

export type DefensePreparationSubscriber = (
	states: readonly DefensePreparationRuntimeState[],
) => void;

const runtimeStates = new Map<string, DefensePreparationRuntimeState>();
const subscribers = new Set<DefensePreparationSubscriber>();
let voiceDefenseSessionLease: string | null = null;

function emitRuntimeStates(): void {
	const snapshot = [...runtimeStates.values()].map((state) => ({
		...state,
		activeChildSessionIds: [...state.activeChildSessionIds],
	}));
	for (const subscriber of subscribers) subscriber(snapshot);
}

export function subscribeDefensePreparations(
	subscriber: DefensePreparationSubscriber,
): () => void {
	subscribers.add(subscriber);
	subscriber([...runtimeStates.values()]);
	return () => subscribers.delete(subscriber);
}

export function getDefensePreparationRuntimeState(
	runId: string,
): DefensePreparationRuntimeState | null {
	const state = runtimeStates.get(runId);
	return state
		? { ...state, activeChildSessionIds: [...state.activeChildSessionIds] }
		: null;
}

export function hasActivePreparationChildren(): boolean {
	return [...runtimeStates.values()].some(
		(state) => state.activeChildSessionIds.length > 0,
	);
}

export function hasActiveDefensePreparations(): boolean {
	return runtimeStates.size > 0;
}

export function isVoiceDefenseSessionActive(): boolean {
	return voiceDefenseSessionLease !== null;
}

export function acquireVoiceDefenseSession(leaseId: string): boolean {
	const normalized = leaseId.trim();
	if (!normalized || voiceDefenseSessionLease !== null) return false;
	voiceDefenseSessionLease = normalized;
	return true;
}

export function releaseVoiceDefenseSession(leaseId: string): void {
	if (voiceDefenseSessionLease === leaseId.trim()) {
		voiceDefenseSessionLease = null;
	}
}

export function registerDefensePreparationRuntime(
	state: DefensePreparationRuntimeState,
): void {
	if (runtimeStates.has(state.runId)) {
		throw new Error(`preparation run is already active: ${state.runId}`);
	}
	runtimeStates.set(state.runId, {
		...state,
		activeChildSessionIds: [...state.activeChildSessionIds],
	});
	emitRuntimeStates();
}

export function patchDefensePreparationRuntime(
	runId: string,
	patch: Partial<DefensePreparationRuntimeState>,
): void {
	const current = runtimeStates.get(runId);
	if (!current) return;
	runtimeStates.set(runId, {
		...current,
		...patch,
		activeChildSessionIds:
			patch.activeChildSessionIds ?? current.activeChildSessionIds,
	});
	emitRuntimeStates();
}

export function addDefensePreparationChild(
	runId: string,
	sessionId: string,
): void {
	const state = runtimeStates.get(runId);
	if (!state || state.activeChildSessionIds.includes(sessionId)) return;
	patchDefensePreparationRuntime(runId, {
		activeChildSessionIds: [...state.activeChildSessionIds, sessionId],
	});
}

export function removeDefensePreparationChild(
	runId: string,
	sessionId: string,
): void {
	const state = runtimeStates.get(runId);
	if (!state) return;
	patchDefensePreparationRuntime(runId, {
		activeChildSessionIds: state.activeChildSessionIds.filter(
			(id) => id !== sessionId,
		),
	});
}

export function unregisterDefensePreparationRuntime(runId: string): void {
	if (!runtimeStates.delete(runId)) return;
	emitRuntimeStates();
}

export function resetDefensePreparationRuntimeForTests(): void {
	runtimeStates.clear();
	subscribers.clear();
	voiceDefenseSessionLease = null;
}
