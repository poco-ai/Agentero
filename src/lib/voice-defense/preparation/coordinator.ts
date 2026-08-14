import i18n from "@/i18n";
import {
	type AgentFailedEvent,
	type AgentResultPayload,
	type AgentUsageEvent,
	cancelAgentRun,
	isAgentRunActive,
	listenAgentCompleted,
	listenAgentFailed,
	listenAgentUsage,
	type RunOnceAccepted,
	runOnce,
} from "@/lib/agent";
import {
	BackgroundTaskCancelledError,
	cancelBackgroundTask,
	enqueueBackgroundTask,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import {
	createVaultSnapshotWorkspace,
	releaseVaultSnapshotWorkspace,
} from "@/lib/vault";
import { composeLocalDefenseBrief } from "@/lib/voice-defense/preparation/local-synthesis";
import {
	buildAnalysisPrompt,
	buildReviewPrompt,
	type DefensePromptLanguage,
	type DefenseTaskEnvelope,
} from "@/lib/voice-defense/preparation/prompts";
import {
	DEFENSE_PREPARATION_SCHEMA_VERSION,
	type DefenseArtifact,
	DefenseOutputValidationError,
	type DefensePreparationManifest,
	type DefensePreparationRole,
	type DefensePreparationSummary,
	parseDefenseStructuredOutput,
	selectLatestReusablePreparationForPaper,
	selectReusablePreparation,
} from "@/lib/voice-defense/preparation/schema";
import {
	createDefaultPaperSnapshotDeps,
	createPaperSnapshot,
	detectPreparationStaleness,
	type PaperSnapshotDeps,
	type PaperSnapshotInput,
} from "@/lib/voice-defense/preparation/snapshot";
import {
	createDefensePreparationManifest,
	type DefensePreparationRuntimeState,
	finishNodeAttempt,
	getDefensePreparationRuntimeState,
	hasActivePreparationChildren,
	isVoiceDefenseSessionActive,
	nextNodeAttempt,
	patchDefensePreparationRuntime,
	reconcileInterruptedPreparation,
	registerDefensePreparationRuntime,
	removeDefensePreparationChild,
	setPreparationStatus,
	startNodeAttempt,
	subscribeDefensePreparations,
	successfulAnalysisRoles,
	unregisterDefensePreparationRuntime,
} from "@/lib/voice-defense/preparation/state";
import {
	createVaultPreparationStorage,
	listDefensePreparationManifests,
	loadDefenseArtifact,
	loadDefensePreparationManifest,
	type PreparationStorage,
	preparationArtifactPath,
	preparationBriefPath,
	summarizeDefensePreparation,
	type VaultPreparationStorageOptions,
	writeDefenseArtifact,
	writeDefenseBrief,
	writePreparationManifest,
} from "@/lib/voice-defense/preparation/storage";

export type PreparationAgentRunInput = {
	vaultRoot: string;
	/** Host-owned immutable local snapshot cwd; absent for remote/test runs. */
	agentVaultRoot?: string;
	role: DefensePreparationRole;
	prompt: string;
	request: {
		agentId?: string;
		modelId?: string;
		reasoningEffort?: string;
		responseLanguage?: string;
		workflow: "voice_defense_preparation" | "voice_defense_review";
		permissionMode: "restricted";
		autoApprove: false;
		hideFromChatHistory: true;
	};
	target: string;
	signal: AbortSignal;
	onStarted: (accepted: RunOnceAccepted) => void;
	onFinished: (sessionId: string) => void;
};

export type PreparationAgentResult = AgentResultPayload & {
	agentId: string;
	usageUsed?: number;
	usageSize?: number;
};

export type PreparationAgentRun = (
	input: PreparationAgentRunInput,
) => Promise<PreparationAgentResult>;

export type PreparationBackgroundTaskContext = {
	id: string;
	signal: AbortSignal;
	setProgress: (progress: number | null) => void;
	setDetail: (detail: string) => void;
};

export type PreparationBackgroundTaskFn<T> = (
	context: PreparationBackgroundTaskContext,
) => Promise<T>;

/** A provider that never emits a terminal event must not block the preparation queue forever. */
export const DEFAULT_PREPARATION_NODE_TIMEOUT_MS = 15 * 60 * 1000;

export type DefensePreparationDependencies = {
	createSnapshot: (
		input: PaperSnapshotInput,
		deps?: PaperSnapshotDeps,
	) => Promise<DefensePreparationManifest["snapshot"]>;
	createSnapshotDeps: () => PaperSnapshotDeps;
	createStorage: (
		vaultRoot: string,
		options?: VaultPreparationStorageOptions,
	) => PreparationStorage;
	storageOptions?: VaultPreparationStorageOptions;
	runAgent: PreparationAgentRun;
	cancelAgent: (sessionId: string) => Promise<void>;
	isAgentRunActive: (sessionId: string) => Promise<boolean>;
	nodeTimeoutMs: number;
	prepareSnapshotWorkspace: (
		vaultRoot: string,
		runId: string,
		sourcePaths: string[],
	) => Promise<string | null>;
	releaseSnapshotWorkspace: (workspacePath: string) => Promise<void>;
	enqueue: <T>(
		input: {
			kind: "voiceDefensePreparation";
			title: string;
			detail?: string;
		},
		fn: PreparationBackgroundTaskFn<T>,
		options: { concurrency: 1; signal: AbortSignal },
	) => Promise<T>;
	now: () => string;
	newId: () => string;
	hashText: (content: string) => Promise<string>;
};

export type DefensePreparationInput = PaperSnapshotInput & {
	language?: DefensePromptLanguage;
	agentId?: string;
	modelId?: string;
	reasoningEffort?: string;
};

export type DefensePreparationHandle = {
	runId: string;
	completion: Promise<DefensePreparationManifest>;
	cancel: () => Promise<void>;
};

export class PreparationStaleError extends Error {
	readonly changedPaths: string[];

	constructor(changedPaths: string[]) {
		super("selected material changed since the preparation snapshot");
		this.name = "PreparationStaleError";
		this.changedPaths = changedPaths;
	}
}

export class DefensePreparationFailedError extends Error {
	readonly manifest: DefensePreparationManifest;

	constructor(message: string, manifest: DefensePreparationManifest) {
		super(message);
		this.name = "DefensePreparationFailedError";
		this.manifest = manifest;
	}
}

type ActiveRun = {
	runId: string;
	vaultRoot: string;
	paperPath: string;
	controller: AbortController;
	agentVaultRoot?: string;
	backgroundTaskId?: string;
	completion: Promise<DefensePreparationManifest>;
};

function generatedId(): string {
	return crypto.randomUUID();
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

async function withDeadline<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function isCancelled(signal: AbortSignal, error: unknown): boolean {
	return signal.aborted || isBackgroundTaskCancelledError(error);
}

function normalizePaperPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * A process-wide ACP terminal-event cache prevents the runOnce/event race:
 * providers may emit `agent:completed` before the invoke command resolves.
 */
class AgentTerminalMonitor {
	private setup: Promise<void> | null = null;
	private outcomes = new Map<
		string,
		(
			| { ok: true; payload: AgentResultPayload }
			| { ok: false; error: string }
		) & { capturedAt: number }
	>();
	private waiters = new Map<
		string,
		Array<{
			resolve: (payload: AgentResultPayload) => void;
			reject: (error: Error) => void;
		}>
	>();
	private usage = new Map<
		string,
		{ used: number; size: number; capturedAt: number }
	>();

	private trimCaptured(): void {
		const now = Date.now();
		for (const [id, cached] of this.outcomes) {
			if (now - cached.capturedAt > 10_000) this.outcomes.delete(id);
		}
		for (const [id, cached] of this.usage) {
			if (now - cached.capturedAt > 10_000) this.usage.delete(id);
		}
		while (this.outcomes.size > 32) {
			const oldest = this.outcomes.keys().next().value as string | undefined;
			if (!oldest) break;
			this.outcomes.delete(oldest);
		}
		while (this.usage.size > 32) {
			const oldest = this.usage.keys().next().value as string | undefined;
			if (!oldest) break;
			this.usage.delete(oldest);
		}
	}

	private complete(
		sessionId: string,
		outcome:
			| { ok: true; payload: AgentResultPayload }
			| { ok: false; error: string },
	): void {
		const waiters = this.waiters.get(sessionId) ?? [];
		if (waiters.length === 0) {
			this.outcomes.set(sessionId, { ...outcome, capturedAt: Date.now() });
			this.trimCaptured();
		} else this.outcomes.delete(sessionId);
		this.waiters.delete(sessionId);
		for (const waiter of waiters) {
			if (outcome.ok) waiter.resolve(outcome.payload);
			else waiter.reject(new Error(outcome.error));
		}
	}

	async ensure(): Promise<void> {
		if (this.setup) return this.setup;
		this.setup = (async () => {
			await listenAgentCompleted((payload) =>
				this.complete(payload.sessionId, { ok: true, payload }),
			);
			await listenAgentFailed((payload: AgentFailedEvent) =>
				this.complete(payload.sessionId, {
					ok: false,
					error: payload.error || "ACP agent failed",
				}),
			);
			await listenAgentUsage((payload: AgentUsageEvent) => {
				this.usage.set(payload.sessionId, {
					used: payload.used,
					size: payload.size,
					capturedAt: Date.now(),
				});
				this.trimCaptured();
			});
		})();
		return this.setup;
	}

	takeUsage(sessionId: string): { used: number; size: number } | undefined {
		const usage = this.usage.get(sessionId);
		this.usage.delete(sessionId);
		return usage ? { used: usage.used, size: usage.size } : undefined;
	}

	wait(sessionId: string, signal: AbortSignal): Promise<AgentResultPayload> {
		const existing = this.outcomes.get(sessionId);
		if (existing && Date.now() - existing.capturedAt <= 10_000) {
			this.outcomes.delete(sessionId);
			return existing.ok
				? Promise.resolve(existing.payload)
				: Promise.reject(new Error(existing.error));
		}
		return new Promise((resolve, reject) => {
			const finishOk = (payload: AgentResultPayload) => {
				signal.removeEventListener("abort", abort);
				resolve(payload);
			};
			const finishError = (error: Error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			};
			const entries = this.waiters.get(sessionId) ?? [];
			entries.push({ resolve: finishOk, reject: finishError });
			this.waiters.set(sessionId, entries);
			const abort = () => {
				const current = this.waiters.get(sessionId) ?? [];
				const remaining = current.filter((entry) => entry.resolve !== finishOk);
				if (remaining.length) this.waiters.set(sessionId, remaining);
				else this.waiters.delete(sessionId);
				this.outcomes.delete(sessionId);
				reject(new BackgroundTaskCancelledError());
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		});
	}
}

const terminalMonitor = new AgentTerminalMonitor();

async function waitUntilAgentInactive(
	sessionId: string,
	isActive: (sessionId: string) => Promise<boolean>,
): Promise<void> {
	for (let attempt = 0; attempt < 1_200; attempt += 1) {
		if (!(await isActive(sessionId))) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`ACP child runtime did not stop: ${sessionId}`);
}

export function createDefaultAgentRunner(
	isAgentRunActive: (sessionId: string) => Promise<boolean>,
	nodeTimeoutMs: number,
): PreparationAgentRun {
	return async (input) => {
		await terminalMonitor.ensure();
		const deadline = Date.now() + nodeTimeoutMs;
		const accepted = await withDeadline(
			runOnce({
				agentId: input.request.agentId,
				modelId: input.request.modelId,
				reasoningEffort: input.request.reasoningEffort,
				vaultPath: input.agentVaultRoot ?? input.vaultRoot,
				workflow: input.request.workflow,
				target: input.target,
				prompt: input.prompt,
				permissionMode: input.request.permissionMode,
				autoApprove: input.request.autoApprove,
				hideFromChatHistory: input.request.hideFromChatHistory,
				responseLanguage: input.request.responseLanguage,
				personalPrompt: "",
			}),
			nodeTimeoutMs,
			`ACP node timed out after ${nodeTimeoutMs}ms`,
		);
		input.onStarted(accepted);
		const waitController = new AbortController();
		let timedOut = false;
		const cancelAndAbortWait = () => {
			void cancelAgentRun(accepted.sessionId).catch(() => undefined);
			waitController.abort();
		};
		if (input.signal.aborted) cancelAndAbortWait();
		else {
			input.signal.addEventListener("abort", cancelAndAbortWait, {
				once: true,
			});
		}
		const timeout = setTimeout(
			() => {
				timedOut = true;
				cancelAndAbortWait();
			},
			Math.max(0, deadline - Date.now()),
		);
		try {
			let payload: AgentResultPayload;
			try {
				payload = await terminalMonitor.wait(
					accepted.sessionId,
					waitController.signal,
				);
			} catch (error) {
				// Aborting the monitor is how we stop a provider that never emits a
				// terminal event, but that abort must remain distinguishable from a
				// user/background cancellation so the node can retry after cleanup.
				if (timedOut && !input.signal.aborted) {
					throw new Error(`ACP node timed out after ${nodeTimeoutMs}ms`);
				}
				throw error;
			}
			if (timedOut) {
				throw new Error(`ACP node timed out after ${nodeTimeoutMs}ms`);
			}
			const usage = terminalMonitor.takeUsage(accepted.sessionId);
			return {
				...payload,
				agentId: accepted.agentId,
				usageUsed: usage?.used,
				usageSize: usage?.size,
			};
		} finally {
			clearTimeout(timeout);
			input.signal.removeEventListener("abort", cancelAndAbortWait);
			await waitUntilAgentInactive(accepted.sessionId, isAgentRunActive);
			input.onFinished(accepted.sessionId);
		}
	};
}

function defaultDependencies(): DefensePreparationDependencies {
	return {
		createSnapshot: createPaperSnapshot,
		createSnapshotDeps: createDefaultPaperSnapshotDeps,
		createStorage: createVaultPreparationStorage,
		nodeTimeoutMs: DEFAULT_PREPARATION_NODE_TIMEOUT_MS,
		runAgent: createDefaultAgentRunner(
			isAgentRunActive,
			DEFAULT_PREPARATION_NODE_TIMEOUT_MS,
		),
		cancelAgent: cancelAgentRun,
		isAgentRunActive,
		prepareSnapshotWorkspace: createVaultSnapshotWorkspace,
		releaseSnapshotWorkspace: releaseVaultSnapshotWorkspace,
		enqueue: (input, fn, options) => enqueueBackgroundTask(input, fn, options),
		now: () => new Date().toISOString(),
		newId: generatedId,
		hashText: async (content) => {
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(content),
			);
			return [...new Uint8Array(digest)]
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join("");
		},
	};
}

function allowedEvidencePaths(
	snapshot: DefensePreparationManifest["snapshot"],
): string[] {
	return [
		...snapshot.sources.map((source) => source.path),
		...snapshot.selections
			.map((selection) => selection.sourcePath)
			.filter((path): path is string => Boolean(path)),
	];
}

type AnalysisRole = "paper-analysis" | "adversarial-review";

function roleKind(role: DefensePreparationRole): DefenseArtifact["kind"] {
	if (role === "adversarial-review") return "review";
	if (role === "synthesis") return "defense-brief";
	return "paper-analysis";
}

function rolePrompt(role: AnalysisRole, envelope: DefenseTaskEnvelope): string {
	if (role === "paper-analysis") return buildAnalysisPrompt(envelope);
	return buildReviewPrompt(envelope);
}

export class DefensePreparationCoordinator {
	private readonly deps: DefensePreparationDependencies;
	private readonly active = new Map<string, ActiveRun>();
	private readonly manifestWrites = new Map<string, Promise<void>>();

	constructor(deps: Partial<DefensePreparationDependencies> = {}) {
		const merged = { ...defaultDependencies(), ...deps };
		if (
			!deps.runAgent &&
			(deps.isAgentRunActive !== undefined || deps.nodeTimeoutMs !== undefined)
		) {
			merged.runAgent = createDefaultAgentRunner(
				merged.isAgentRunActive,
				merged.nodeTimeoutMs,
			);
		}
		this.deps = merged;
	}

	private storage(vaultRoot: string): PreparationStorage {
		return this.deps.createStorage(vaultRoot, this.deps.storageOptions);
	}

	private async assertSnapshotFresh(
		storage: PreparationStorage,
		manifest: DefensePreparationManifest,
		input: PaperSnapshotInput,
	): Promise<void> {
		const current = await this.deps.createSnapshot(
			{
				vaultRoot: input.vaultRoot,
				paperPath: manifest.paperPath,
				materials: input.materials ?? manifest.snapshot.materials,
				instruction: input.instruction ?? manifest.snapshot.instruction,
				title: input.title ?? manifest.snapshot.title,
				metadata: input.metadata ?? manifest.snapshot.metadata,
				selections: input.selections ?? manifest.snapshot.selections,
			},
			this.deps.createSnapshotDeps(),
		);
		const stale = detectPreparationStaleness(manifest.snapshot, current);
		if (!stale.stale) return;
		manifest.stale = true;
		manifest.warnings = [
			...new Set([
				...manifest.warnings,
				`Selected material changed: ${stale.changedPaths.join(", ")}`,
			]),
		];
		manifest.updatedAt = this.deps.now();
		await this.persist(storage, manifest);
		throw new PreparationStaleError(stale.changedPaths);
	}

	private async persist(
		storage: PreparationStorage,
		manifest: DefensePreparationManifest,
	): Promise<void> {
		const snapshot = structuredClone(manifest);
		patchDefensePreparationRuntime(manifest.runId, { manifest: snapshot });
		const previous =
			this.manifestWrites.get(manifest.runId) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(() => writePreparationManifest(storage, snapshot));
		this.manifestWrites.set(manifest.runId, next);
		try {
			await next;
		} finally {
			if (this.manifestWrites.get(manifest.runId) === next) {
				this.manifestWrites.delete(manifest.runId);
			}
		}
	}

	private async validatedAnalysisArtifacts(
		storage: PreparationStorage,
		manifest: DefensePreparationManifest,
	): Promise<DefenseArtifact[]> {
		const artifacts: DefenseArtifact[] = [];
		for (const role of successfulAnalysisRoles(manifest)) {
			const node = manifest.nodes[role];
			if (!node.artifactId || !node.artifactPath) {
				throw new Error(`validated ${role} artifact reference is missing`);
			}
			const artifact = await loadDefenseArtifact(storage, node.artifactPath);
			if (
				!artifact ||
				artifact.runId !== manifest.runId ||
				artifact.taskId !== node.taskId ||
				artifact.artifactId !== node.artifactId ||
				artifact.kind !== roleKind(role) ||
				artifact.status === "invalid" ||
				artifact.contentPath !== node.artifactPath ||
				artifact.contentPath !==
					preparationArtifactPath(manifest.runId, role, artifact.attempt) ||
				!artifact.payload
			) {
				throw new Error(
					`validated ${role} artifact is missing or was modified`,
				);
			}
			const payload = parseDefenseStructuredOutput(
				role,
				JSON.stringify(artifact.payload),
				allowedEvidencePaths(manifest.snapshot),
			);
			if (
				(await this.deps.hashText(JSON.stringify(payload))) !==
				artifact.contentSha256
			) {
				throw new Error(`validated ${role} artifact hash does not match`);
			}
			artifacts.push({ ...artifact, payload });
		}
		return artifacts;
	}

	private async assertManifestSessionsInactive(
		manifest: DefensePreparationManifest,
	): Promise<void> {
		const sessionIds = new Set(
			Object.values(manifest.nodes).flatMap((node) =>
				node.attempts.flatMap((attempt) =>
					attempt.sessionId ? [attempt.sessionId] : [],
				),
			),
		);
		for (const sessionId of sessionIds) {
			if (await this.deps.isAgentRunActive(sessionId)) {
				throw new Error(
					`preparation ACP runtime is still active: ${sessionId}`,
				);
			}
		}
	}

	private async reconcileReviewableBrief(
		storage: PreparationStorage,
		manifest: DefensePreparationManifest,
	): Promise<void> {
		if (
			this.active.has(manifest.runId) ||
			getDefensePreparationRuntimeState(manifest.runId) ||
			!manifest.briefPath ||
			manifest.nodes.synthesis.status !== "succeeded" ||
			(manifest.status !== "created" &&
				manifest.status !== "snapshotting" &&
				manifest.status !== "analyzing" &&
				manifest.status !== "synthesizing")
		) {
			return;
		}
		const brief = await storage.readText(manifest.briefPath);
		if (!brief.trim()) return;
		setPreparationStatus(manifest, "awaiting_review", this.deps.now());
		await this.persist(storage, manifest);
	}

	private checkDuplicate(input: DefensePreparationInput): void {
		const paperPath = normalizePaperPath(input.paperPath);
		for (const run of this.active.values()) {
			if (run.vaultRoot === input.vaultRoot && run.paperPath === paperPath) {
				throw new Error(`preparation run already active for ${paperPath}`);
			}
		}
	}

	start(input: DefensePreparationInput): DefensePreparationHandle {
		if (isVoiceDefenseSessionActive()) {
			throw new Error("cannot prepare defense material during a Voice session");
		}
		this.checkDuplicate(input);
		const runId = this.deps.newId();
		const controller = new AbortController();
		const activeRun: ActiveRun = {
			runId,
			vaultRoot: input.vaultRoot,
			paperPath: normalizePaperPath(input.paperPath),
			controller,
			completion: new Promise<DefensePreparationManifest>(() => undefined),
		};
		registerDefensePreparationRuntime({
			runId,
			vaultRoot: input.vaultRoot,
			paperPath: normalizePaperPath(input.paperPath),
			manifest: null,
			activeChildSessionIds: [],
			cancelRequested: false,
			startedAt: this.deps.now(),
		});

		const completion = this.deps.enqueue(
			{
				kind: "voiceDefensePreparation",
				title: i18n.t("app:tasks.voiceDefensePreparation"),
				detail: i18n.t("app:tasks.voiceDefensePreparationQueued"),
			},
			async (backgroundContext) => {
				activeRun.backgroundTaskId = backgroundContext.id;
				patchDefensePreparationRuntime(runId, {
					backgroundTaskId: backgroundContext.id,
				});
				backgroundContext.signal.addEventListener(
					"abort",
					() => controller.abort(),
					{ once: true },
				);
				return this.execute(input, undefined, activeRun, backgroundContext);
			},
			{ concurrency: 1, signal: controller.signal },
		);
		activeRun.completion = completion;
		this.active.set(runId, activeRun);
		void completion
			.finally(() => {
				this.active.delete(runId);
				if (
					!getDefensePreparationRuntimeState(runId)?.activeChildSessionIds
						.length
				) {
					unregisterDefensePreparationRuntime(runId);
				}
			})
			.catch(() => undefined);
		void completion.catch(() => undefined);
		return {
			runId,
			completion,
			cancel: () => this.cancel(runId),
		};
	}

	async resume(
		input: DefensePreparationInput & { runId: string },
	): Promise<DefensePreparationManifest> {
		if (this.active.has(input.runId)) {
			return (
				this.active.get(input.runId)?.completion ??
				Promise.reject(new Error("run unavailable"))
			);
		}
		const storage = this.storage(input.vaultRoot);
		const loaded = await loadDefensePreparationManifest(storage, input.runId);
		if (!loaded)
			throw new Error(`preparation manifest not found: ${input.runId}`);
		await this.assertSnapshotFresh(storage, loaded, input);
		if (
			loaded.status === "awaiting_review" ||
			loaded.status === "ready" ||
			loaded.status === "completed"
		) {
			return loaded;
		}
		if (isVoiceDefenseSessionActive()) {
			throw new Error(
				"cannot resume defense preparation during a Voice session",
			);
		}
		this.checkDuplicate({ ...input, paperPath: loaded.paperPath });
		const reconciled = reconcileInterruptedPreparation(loaded, this.deps.now());
		reconciled.stale = false;
		const controller = new AbortController();
		const activeRun: ActiveRun = {
			runId: input.runId,
			vaultRoot: input.vaultRoot,
			paperPath: reconciled.paperPath,
			controller,
			completion: Promise.resolve(reconciled),
		};
		registerDefensePreparationRuntime({
			runId: input.runId,
			vaultRoot: input.vaultRoot,
			paperPath: reconciled.paperPath,
			manifest: reconciled,
			activeChildSessionIds: [],
			cancelRequested: false,
			startedAt: this.deps.now(),
		});
		const completion = this.deps.enqueue(
			{
				kind: "voiceDefensePreparation",
				title: i18n.t("app:tasks.voiceDefensePreparation"),
				detail: i18n.t("app:tasks.voiceDefensePreparationRunning"),
			},
			async (backgroundContext) => {
				activeRun.backgroundTaskId = backgroundContext.id;
				patchDefensePreparationRuntime(input.runId, {
					backgroundTaskId: backgroundContext.id,
				});
				backgroundContext.signal.addEventListener(
					"abort",
					() => controller.abort(),
					{ once: true },
				);
				return this.execute(input, reconciled, activeRun, backgroundContext);
			},
			{ concurrency: 1, signal: controller.signal },
		);
		activeRun.completion = completion;
		this.active.set(input.runId, activeRun);
		void completion
			.finally(() => {
				this.active.delete(input.runId);
				if (
					!getDefensePreparationRuntimeState(input.runId)?.activeChildSessionIds
						.length
				) {
					unregisterDefensePreparationRuntime(input.runId);
				}
			})
			.catch(() => undefined);
		void completion.catch(() => undefined);
		return completion;
	}

	async cancel(runId: string): Promise<void> {
		const active = this.active.get(runId);
		const runtime = getDefensePreparationRuntimeState(runId);
		if (!active && !runtime) return;
		const children = runtime?.activeChildSessionIds ?? [];
		patchDefensePreparationRuntime(runId, { cancelRequested: true });
		active?.controller.abort();
		if (active?.backgroundTaskId) cancelBackgroundTask(active.backgroundTaskId);
		await Promise.allSettled(
			children.map((sessionId) => this.deps.cancelAgent(sessionId)),
		);
		const stopped = await Promise.allSettled(
			children.map(async (sessionId) => {
				await waitUntilAgentInactive(sessionId, this.deps.isAgentRunActive);
				removeChildSession(runId, sessionId);
			}),
		);
		await active?.completion.catch(() => undefined);
		if (
			!getDefensePreparationRuntimeState(runId)?.activeChildSessionIds.length
		) {
			this.active.delete(runId);
			unregisterDefensePreparationRuntime(runId);
		}
		const stopFailure = stopped.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (stopFailure) throw stopFailure.reason;
	}

	async load(
		vaultRoot: string,
		runId: string,
	): Promise<DefensePreparationManifest | null> {
		return loadDefensePreparationManifest(this.storage(vaultRoot), runId);
	}

	async list(vaultRoot: string): Promise<DefensePreparationSummary[]> {
		return (await listDefensePreparationManifests(this.storage(vaultRoot))).map(
			summarizeDefensePreparation,
		);
	}

	async findReusable(
		vaultRoot: string,
		snapshotSha256: string,
	): Promise<DefensePreparationManifest | null> {
		return selectReusablePreparation(
			await listDefensePreparationManifests(this.storage(vaultRoot)),
			snapshotSha256,
		);
	}

	async findLatestReusableForPaper(
		vaultRoot: string,
		paperPath: string,
	): Promise<DefensePreparationManifest | null> {
		return selectLatestReusablePreparationForPaper(
			await listDefensePreparationManifests(this.storage(vaultRoot)),
			paperPath,
		);
	}

	async refresh(
		vaultRoot: string,
		runId: string,
		current: Omit<PaperSnapshotInput, "vaultRoot" | "paperPath"> = {},
	): Promise<DefensePreparationManifest> {
		const storage = this.storage(vaultRoot);
		const manifest = await loadDefensePreparationManifest(storage, runId);
		if (!manifest) throw new Error(`preparation manifest not found: ${runId}`);
		try {
			await this.assertSnapshotFresh(storage, manifest, {
				vaultRoot,
				paperPath: manifest.paperPath,
				...current,
			});
		} catch (error) {
			if (!(error instanceof PreparationStaleError)) throw error;
		}
		await this.reconcileReviewableBrief(storage, manifest);
		return manifest;
	}

	async confirm(
		vaultRoot: string,
		runId: string,
		editedBrief?: string,
		options: {
			current?: Omit<PaperSnapshotInput, "vaultRoot" | "paperPath">;
			allowStale?: boolean;
		} = {},
	): Promise<DefensePreparationManifest> {
		const storage = this.storage(vaultRoot);
		const manifest = await loadDefensePreparationManifest(storage, runId);
		if (!manifest) throw new Error(`preparation manifest not found: ${runId}`);
		await this.reconcileReviewableBrief(storage, manifest);
		const canUseExistingFailure = Boolean(
			options.allowStale &&
				manifest.briefPath &&
				(manifest.status === "failed" || manifest.status === "cancelled"),
		);
		if (
			manifest.status !== "awaiting_review" &&
			manifest.status !== "ready" &&
			manifest.status !== "completed" &&
			!canUseExistingFailure
		) {
			throw new Error(`preparation is not awaiting review: ${manifest.status}`);
		}
		if (
			getDefensePreparationRuntimeState(runId)?.activeChildSessionIds.length
		) {
			throw new Error("preparation ACP runtime is still active");
		}
		await this.assertManifestSessionsInactive(manifest);
		try {
			await this.assertSnapshotFresh(storage, manifest, {
				vaultRoot,
				paperPath: manifest.paperPath,
				...(options.current ?? {}),
			});
		} catch (error) {
			if (!(error instanceof PreparationStaleError) || !options.allowStale) {
				throw error;
			}
		}
		let edited = false;
		if (editedBrief !== undefined) {
			if (manifest.briefPath) {
				try {
					edited = (await storage.readText(manifest.briefPath)) !== editedBrief;
				} catch {
					edited = true;
				}
			}
			manifest.briefPath = await writeDefenseBrief(storage, runId, editedBrief);
		} else if (!manifest.briefPath) {
			manifest.briefPath = preparationBriefPath(runId);
		}
		const confirmedAt = this.deps.now();
		manifest.review = { confirmedAt, edited };
		setPreparationStatus(manifest, "ready", confirmedAt);
		await this.persist(storage, manifest);
		return manifest;
	}

	async complete(
		vaultRoot: string,
		runId: string,
	): Promise<DefensePreparationManifest> {
		const storage = this.storage(vaultRoot);
		const manifest = await loadDefensePreparationManifest(storage, runId);
		if (!manifest) throw new Error(`preparation manifest not found: ${runId}`);
		if (manifest.status !== "ready" && manifest.status !== "completed") {
			throw new Error(`preparation is not ready: ${manifest.status}`);
		}
		if (hasActivePreparationChildren()) {
			throw new Error("a defense preparation ACP runtime is still active");
		}
		const completedAt = this.deps.now();
		manifest.review = {
			confirmedAt: manifest.review?.confirmedAt ?? completedAt,
			edited: manifest.review?.edited ?? false,
			completedAt,
		};
		setPreparationStatus(manifest, "completed", completedAt);
		await this.persist(storage, manifest);
		return manifest;
	}

	getState(runId: string): DefensePreparationRuntimeState | null {
		return getDefensePreparationRuntimeState(runId);
	}

	private async execute(
		input: DefensePreparationInput,
		existing: DefensePreparationManifest | undefined,
		active: ActiveRun,
		backgroundContext: PreparationBackgroundTaskContext,
	): Promise<DefensePreparationManifest> {
		const storage = this.storage(input.vaultRoot);
		let manifest = existing;
		try {
			backgroundContext.setProgress(5);
			backgroundContext.setDetail(
				i18n.t("app:tasks.voiceDefensePreparationSnapshotting"),
			);
			if (!manifest) {
				const snapshot = await this.deps.createSnapshot(
					input,
					this.deps.createSnapshotDeps(),
				);
				manifest = createDefensePreparationManifest({
					runId: active.runId,
					snapshot,
					now: this.deps.now(),
				});
				setPreparationStatus(manifest, "snapshotting", this.deps.now());
				patchDefensePreparationRuntime(active.runId, { manifest });
				await this.persist(storage, manifest);
			}
			if (!manifest) throw new Error("preparation manifest was not created");
			if (active.controller.signal.aborted)
				throw new BackgroundTaskCancelledError();
			await this.assertSnapshotFresh(storage, manifest, input);
			active.agentVaultRoot =
				(await this.deps.prepareSnapshotWorkspace(
					input.vaultRoot,
					manifest.runId,
					manifest.snapshot.sources.map((source) => source.path),
				)) ?? undefined;
			backgroundContext.setProgress(10);
			backgroundContext.setDetail(
				i18n.t("app:tasks.voiceDefensePreparationAnalyzing"),
			);
			setPreparationStatus(manifest, "analyzing", this.deps.now());
			await this.persist(storage, manifest);
			const analysisRoles = (
				["paper-analysis", "adversarial-review"] as const
			).filter((role) => manifest?.nodes[role].status !== "succeeded");
			await Promise.allSettled(
				analysisRoles.map((role) =>
					this.runNode(
						input,
						manifest as DefensePreparationManifest,
						role,
						active,
						storage,
					),
				),
			);
			const lingeringChildren =
				getDefensePreparationRuntimeState(active.runId)
					?.activeChildSessionIds ?? [];
			if (lingeringChildren.length > 0) {
				throw new Error(
					`preparation ACP runtimes did not stop: ${lingeringChildren.join(", ")}`,
				);
			}
			if (active.controller.signal.aborted)
				throw new BackgroundTaskCancelledError();
			await this.assertSnapshotFresh(storage, manifest, input);
			backgroundContext.setProgress(65);
			const successful = successfulAnalysisRoles(manifest);
			if (successful.length === 0) {
				setPreparationStatus(
					manifest,
					active.controller.signal.aborted ? "cancelled" : "failed",
					this.deps.now(),
				);
				await this.persist(storage, manifest);
				if (active.controller.signal.aborted)
					throw new BackgroundTaskCancelledError();
				throw new DefensePreparationFailedError(
					"both defense preparation analysis branches failed",
					manifest,
				);
			}
			if (manifest.nodes.synthesis.status !== "succeeded") {
				backgroundContext.setProgress(70);
				backgroundContext.setDetail(
					i18n.t("app:tasks.voiceDefensePreparationSynthesizing"),
				);
				manifest.partial = successful.length < 2;
				setPreparationStatus(manifest, "synthesizing", this.deps.now());
				await this.persist(storage, manifest);
				// Synthesis is deterministic local rendering of the validated
				// artifacts — no third ACP round-trip.
				await this.runLocalSynthesis(input, manifest, storage);
			}
			await this.assertSnapshotFresh(storage, manifest, input);
			if (manifest.nodes.synthesis.status === "succeeded") {
				setPreparationStatus(manifest, "awaiting_review", this.deps.now());
				backgroundContext.setProgress(100);
				backgroundContext.setDetail(
					i18n.t("app:tasks.voiceDefensePreparationAwaitingReview"),
				);
			} else if (manifest.status !== "cancelled") {
				setPreparationStatus(manifest, "failed", this.deps.now());
			}
			await this.persist(storage, manifest);
			if (manifest.nodes.synthesis.status !== "succeeded") {
				throw new DefensePreparationFailedError(
					"defense brief synthesis failed",
					manifest,
				);
			}
			return manifest;
		} catch (error) {
			if (isCancelled(active.controller.signal, error)) {
				if (manifest) {
					setPreparationStatus(manifest, "cancelled", this.deps.now());
					await this.persist(storage, manifest);
				}
				throw new BackgroundTaskCancelledError();
			}
			if (manifest) {
				if (error instanceof DefensePreparationFailedError) throw error;
				manifest.warnings.push(asError(error).message);
				setPreparationStatus(manifest, "failed", this.deps.now());
				await this.persist(storage, manifest);
			}
			throw error;
		} finally {
			const workspacePath = active.agentVaultRoot;
			active.agentVaultRoot = undefined;
			if (workspacePath) {
				await this.deps
					.releaseSnapshotWorkspace(workspacePath)
					.catch(() => undefined);
			}
		}
	}

	/**
	 * Render the brief locally from the validated analysis artifacts. Keeps the
	 * full node/attempt state machine so manifests, resume, and the three-stage
	 * UI behave exactly as before — the step just completes in milliseconds.
	 */
	private async runLocalSynthesis(
		input: DefensePreparationInput,
		manifest: DefensePreparationManifest,
		storage: PreparationStorage,
	): Promise<void> {
		const role = "synthesis" as const;
		const node = manifest.nodes[role];
		const attemptNumber = nextNodeAttempt(manifest, role);
		startNodeAttempt(manifest, role, {
			attempt: attemptNumber,
			startedAt: this.deps.now(),
		});
		await this.persist(storage, manifest);
		try {
			const validatedArtifacts = await this.validatedAnalysisArtifacts(
				storage,
				manifest,
			);
			const composed = composeLocalDefenseBrief({
				artifacts: validatedArtifacts,
				snapshot: manifest.snapshot,
				partial: manifest.partial,
				language: input.language ?? "en",
			});
			// Same schema gate the ACP synthesis worker had to pass.
			const payload = parseDefenseStructuredOutput(
				role,
				JSON.stringify(composed),
				allowedEvidencePaths(manifest.snapshot),
			);
			if (payload.kind !== "defense-brief") {
				throw new DefenseOutputValidationError(
					"local synthesis produced the wrong kind",
				);
			}
			const artifact: DefenseArtifact = {
				schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
				artifactId: this.deps.newId(),
				runId: manifest.runId,
				taskId: node.taskId,
				attempt: attemptNumber,
				kind: roleKind(role),
				producer: "local-synthesis",
				contentPath: preparationArtifactPath(
					manifest.runId,
					role,
					attemptNumber,
				),
				contentSha256: await this.deps.hashText(JSON.stringify(payload)),
				sources: payload.sources,
				status: manifest.partial ? "partial" : "valid",
				warnings: payload.warnings,
				createdAt: this.deps.now(),
				payload,
			};
			await writeDefenseArtifact(storage, artifact);
			manifest.briefPath = await writeDefenseBrief(
				storage,
				manifest.runId,
				payload.markdown,
			);
			finishNodeAttempt(manifest, role, attemptNumber, {
				status: "succeeded",
				finishedAt: this.deps.now(),
				artifactId: artifact.artifactId,
				artifactPath: artifact.contentPath,
			});
			await this.persist(storage, manifest);
		} catch (error) {
			finishNodeAttempt(manifest, role, attemptNumber, {
				status: "failed",
				finishedAt: this.deps.now(),
				error: asError(error).message,
			});
			await this.persist(storage, manifest);
		}
	}

	private async runNode(
		input: DefensePreparationInput,
		manifest: DefensePreparationManifest,
		role: AnalysisRole,
		active: ActiveRun,
		storage: PreparationStorage,
		autoRetryRemaining = 1,
	): Promise<void> {
		const node = manifest.nodes[role];
		const attemptNumber = nextNodeAttempt(manifest, role);
		const startedAt = this.deps.now();
		const attemptRecord = startNodeAttempt(manifest, role, {
			attempt: attemptNumber,
			startedAt,
		});
		attemptRecord.agentId = input.agentId;
		attemptRecord.modelId = input.modelId;
		attemptRecord.reasoningEffort = input.reasoningEffort;
		await this.persist(storage, manifest);
		const language = input.language ?? "en";
		const envelope: DefenseTaskEnvelope = {
			schemaVersion: 1,
			runId: manifest.runId,
			taskId: node.taskId,
			attempt: attemptNumber,
			role,
			objective:
				role === "paper-analysis"
					? "Build an evidence-backed map of the complete selected material bundle."
					: "Find rigorous defense questions and weaknesses independently.",
			paperSnapshot: manifest.snapshot,
			inputArtifacts: [],
			outputKind: roleKind(role),
			language,
		};
		let acceptedSessionId: string | undefined;
		let rawOutput: string | undefined;
		let invalidArtifactId: string | undefined;
		let invalidArtifactPath: string | undefined;
		try {
			const result = await this.deps.runAgent({
				vaultRoot: input.vaultRoot,
				agentVaultRoot: active.agentVaultRoot,
				target: manifest.paperPath,
				role,
				prompt: rolePrompt(role, envelope),
				request: {
					agentId: input.agentId,
					modelId: input.modelId,
					reasoningEffort: input.reasoningEffort,
					responseLanguage: language,
					workflow: "voice_defense_preparation",
					permissionMode: "restricted",
					autoApprove: false,
					hideFromChatHistory: true,
				},
				signal: active.controller.signal,
				onStarted: (accepted) => {
					acceptedSessionId = accepted.sessionId;
					attemptRecord.sessionId = accepted.sessionId;
					attemptRecord.agentId = accepted.agentId;
					addChildSession(active.runId, accepted.sessionId);
					void this.persist(storage, manifest);
				},
				onFinished: (sessionId) => removeChildSession(active.runId, sessionId),
			});
			rawOutput = result.content;
			const payload = parseDefenseStructuredOutput(
				role,
				result.content,
				allowedEvidencePaths(manifest.snapshot),
			);
			const artifact: DefenseArtifact = {
				schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
				artifactId: this.deps.newId(),
				runId: manifest.runId,
				taskId: node.taskId,
				attempt: attemptNumber,
				kind: roleKind(role),
				producer: result.agentId,
				contentPath: preparationArtifactPath(
					manifest.runId,
					role,
					attemptNumber,
				),
				contentSha256: await this.deps.hashText(JSON.stringify(payload)),
				sources: payload.sources,
				status: "valid",
				warnings: payload.warnings,
				createdAt: this.deps.now(),
				payload,
			};
			await writeDefenseArtifact(storage, artifact);
			finishNodeAttempt(manifest, role, attemptNumber, {
				status: "succeeded",
				finishedAt: this.deps.now(),
				agentId: result.agentId,
				sessionId: result.sessionId,
				providerSessionId: result.providerSessionId ?? undefined,
				artifactId: artifact.artifactId,
				artifactPath: artifact.contentPath,
				stopReason: result.stopReason ?? undefined,
				usageUsed: result.usageUsed,
				usageSize: result.usageSize,
			});
			await this.persist(storage, manifest);
		} catch (error) {
			const cancelled = isCancelled(active.controller.signal, error);
			const message = asError(error).message;
			const invalid = error instanceof DefenseOutputValidationError;
			if (invalid && !cancelled) {
				const artifact: DefenseArtifact = {
					schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
					artifactId: this.deps.newId(),
					runId: manifest.runId,
					taskId: node.taskId,
					attempt: attemptNumber,
					kind: roleKind(role),
					producer: input.agentId ?? "unknown",
					contentPath: preparationArtifactPath(
						manifest.runId,
						role,
						attemptNumber,
					),
					contentSha256: await this.deps.hashText(rawOutput ?? message),
					sources: [],
					status: "invalid",
					warnings: [],
					createdAt: this.deps.now(),
					rawOutput,
					error: message,
				};
				await writeDefenseArtifact(storage, artifact);
				invalidArtifactId = artifact.artifactId;
				invalidArtifactPath = artifact.contentPath;
			}
			finishNodeAttempt(manifest, role, attemptNumber, {
				status: cancelled ? "cancelled" : "failed",
				finishedAt: this.deps.now(),
				sessionId: acceptedSessionId,
				artifactId: invalidArtifactId,
				artifactPath: invalidArtifactPath,
				error: message,
			});
			await this.persist(storage, manifest);
			if (cancelled) throw new BackgroundTaskCancelledError();
			const childStillActive = Boolean(
				acceptedSessionId &&
					getDefensePreparationRuntimeState(
						active.runId,
					)?.activeChildSessionIds.includes(acceptedSessionId),
			);
			if (autoRetryRemaining > 0 && !childStillActive) {
				await this.runNode(
					input,
					manifest,
					role,
					active,
					storage,
					autoRetryRemaining - 1,
				);
			}
		}
	}
}

function addChildSession(runId: string, sessionId: string): void {
	const state = getDefensePreparationRuntimeState(runId);
	if (!state || state.activeChildSessionIds.includes(sessionId)) return;
	patchDefensePreparationRuntime(runId, {
		activeChildSessionIds: [...state.activeChildSessionIds, sessionId],
	});
}

function removeChildSession(runId: string, sessionId: string): void {
	removeDefensePreparationChild(runId, sessionId);
}

export const defaultDefensePreparationCoordinator =
	new DefensePreparationCoordinator();

export function startDefensePreparation(
	input: DefensePreparationInput,
): DefensePreparationHandle {
	return defaultDefensePreparationCoordinator.start(input);
}

export function resumeDefensePreparation(
	input: DefensePreparationInput & { runId: string },
): Promise<DefensePreparationManifest> {
	return defaultDefensePreparationCoordinator.resume(input);
}

export function cancelDefensePreparation(runId: string): Promise<void> {
	return defaultDefensePreparationCoordinator.cancel(runId);
}

export function loadDefensePreparation(
	vaultRoot: string,
	runId: string,
): Promise<DefensePreparationManifest | null> {
	return defaultDefensePreparationCoordinator.load(vaultRoot, runId);
}

export function listDefensePreparations(
	vaultRoot: string,
): Promise<DefensePreparationSummary[]> {
	return defaultDefensePreparationCoordinator.list(vaultRoot);
}

export function findReusableDefensePreparation(
	vaultRoot: string,
	snapshotSha256: string,
): Promise<DefensePreparationManifest | null> {
	return defaultDefensePreparationCoordinator.findReusable(
		vaultRoot,
		snapshotSha256,
	);
}

export function findLatestReusableDefensePreparationForPaper(
	vaultRoot: string,
	paperPath: string,
): Promise<DefensePreparationManifest | null> {
	return defaultDefensePreparationCoordinator.findLatestReusableForPaper(
		vaultRoot,
		paperPath,
	);
}

export function refreshDefensePreparation(
	vaultRoot: string,
	runId: string,
	current?: Omit<PaperSnapshotInput, "vaultRoot" | "paperPath">,
): Promise<DefensePreparationManifest> {
	return defaultDefensePreparationCoordinator.refresh(
		vaultRoot,
		runId,
		current,
	);
}

export function confirmDefensePreparation(
	vaultRoot: string,
	runId: string,
	editedBrief?: string,
	options?: {
		current?: Omit<PaperSnapshotInput, "vaultRoot" | "paperPath">;
		allowStale?: boolean;
	},
): Promise<DefensePreparationManifest> {
	return defaultDefensePreparationCoordinator.confirm(
		vaultRoot,
		runId,
		editedBrief,
		options,
	);
}

export function completeDefensePreparation(
	vaultRoot: string,
	runId: string,
): Promise<DefensePreparationManifest> {
	return defaultDefensePreparationCoordinator.complete(vaultRoot, runId);
}

export async function waitForPreparationChildrenIdle(
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (hasActivePreparationChildren()) {
		if (Date.now() >= deadline) {
			throw new Error("defense preparation ACP runtimes did not stop");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}

export {
	getDefensePreparationRuntimeState,
	hasActivePreparationChildren,
	subscribeDefensePreparations,
};
