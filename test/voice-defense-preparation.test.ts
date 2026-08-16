import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import type { FileNode } from "@/lib/vault";
import {
	DefensePreparationCoordinator,
	type DefensePreparationDependencies,
	DefensePreparationFailedError,
	type PreparationAgentResult,
	type PreparationAgentRunInput,
	PreparationStaleError,
	preparationFailureDescription,
} from "@/lib/voice-defense/preparation/coordinator";
import {
	buildAnalysisPrompt,
	buildReviewPrompt,
} from "@/lib/voice-defense/preparation/prompts";
import {
	DEFENSE_PREPARATION_SCHEMA_VERSION,
	DefenseOutputValidationError,
	type DefensePreparationManifest,
	DefenseProviderDiagnosticError,
	isSafeVaultRelativePath,
	type PaperSnapshot,
	parseDefenseStructuredOutput,
	selectLatestReusablePreparationForPaper,
	selectReusablePreparation,
} from "@/lib/voice-defense/preparation/schema";
import {
	createPaperSnapshot,
	detectPreparationStaleness,
	type PaperSnapshotDeps,
} from "@/lib/voice-defense/preparation/snapshot";
import {
	acquireVoiceDefenseSession,
	clearVoiceDefenseSessionLease,
	createDefensePreparationManifest,
	hasActiveDefensePreparations,
	hasActivePreparationChildren,
	isVoiceDefenseSessionActive,
	registerDefensePreparationRuntime,
	releaseVoiceDefenseSession,
	resetDefensePreparationRuntimeForTests,
} from "@/lib/voice-defense/preparation/state";
import {
	type PreparationStorage,
	type PreparationStorageEntry,
	preparationArtifactPath,
	preparationBriefPath,
	preparationManifestPath,
} from "@/lib/voice-defense/preparation/storage";

const SOURCE = "papers/demo/PAPER.md";

const ACP_PROVIDER_403_OUTPUT = [
	"Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.",
	"",
	"unexpected status 403 Forbidden: 该渠道不允许当前客户端使用（检测到：@agentclientprotocol/codex-acp/0.146.1 (Mac OS 26.3.1; arm64) unknown (@agentclientprotocol/codex-acp; 1.1.10)）, url: https://ai.centos.hk/v1/responses, request id: req-test",
].join("\n");

const ANALYSIS_TOPICS = [
	"research-problem",
	"contributions",
	"method",
	"assumptions",
	"experiments",
	"results",
	"ablations-robustness-errors",
	"limitations-future-work",
	"key-elements",
] as const;

const REVIEW_CATEGORIES = [
	"motivation",
	"novelty-related-work",
	"assumptions",
	"experimental-validity",
	"evidence-overclaim",
	"failures-boundaries-reproducibility",
] as const;

function fakeHash(content: string): string {
	return content.length.toString(16).padStart(64, "0").slice(-64);
}

class MemoryPreparationStorage implements PreparationStorage {
	readonly files = new Map<string, string>();
	readonly atomicWrites: string[] = [];

	async readText(relativePath: string): Promise<string> {
		const value = this.files.get(relativePath);
		if (value === undefined) throw new Error(`missing: ${relativePath}`);
		return value;
	}

	async writeText(relativePath: string, content: string): Promise<void> {
		this.files.set(relativePath, content);
	}

	async writeTextAtomic(relativePath: string, content: string): Promise<void> {
		this.atomicWrites.push(relativePath);
		this.files.set(relativePath, content);
	}

	async list(relativeDirectory: string): Promise<PreparationStorageEntry[]> {
		const prefix = `${relativeDirectory.replace(/\/$/, "")}/`;
		const entries = new Map<string, PreparationStorageEntry>();
		for (const path of this.files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const [name, ...tail] = rest.split("/");
			if (!name) continue;
			entries.set(name, {
				name,
				kind: tail.length ? "directory" : "file",
			});
		}
		return [...entries.values()];
	}
}

function snapshot(hash = "1".repeat(64)): PaperSnapshot {
	return {
		schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
		paperPath: "papers/demo",
		materials: [{ path: "papers/demo", kind: "directory" }],
		instruction: "",
		title: "Demo",
		metadata: { title: "Demo" },
		selections: [],
		sources: [
			{
				path: SOURCE,
				kind: "text",
				size: 10,
				modifiedAt: "2026-01-01T00:00:00.000Z",
				sha256: "2".repeat(64),
			},
		],
		snapshotSha256: hash,
		warnings: [],
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function evidence(path = SOURCE) {
	return { path, confidence: "high" as const };
}

function analysisOutput() {
	return JSON.stringify({
		schemaVersion: 1,
		kind: "paper-analysis",
		overview: "Research map",
		sections: ANALYSIS_TOPICS.map((topic) => ({
			topic,
			heading: topic,
			content: `${topic} details`,
			verification: "verified",
			evidence: [evidence()],
		})),
		sources: [evidence()],
		warnings: [],
	});
}

function reviewOutput() {
	return JSON.stringify({
		schemaVersion: 1,
		kind: "review",
		overview: "Risk map",
		questions: REVIEW_CATEGORIES.map((category, index) => ({
			category,
			difficulty:
				index === 0 ? "basic" : index === 1 ? "intermediate" : "advanced",
			question: `Question about ${category}?`,
			rationale: `Tests ${category}`,
			followUps: [`Follow up on ${category}`],
			answerOutline: `Evidence-based answer for ${category}`,
			verification: "verified",
			evidence: [evidence()],
		})),
		sources: [evidence()],
		warnings: [],
	});
}

function briefOutput(markdown: string, partial: boolean) {
	return JSON.stringify({
		schemaVersion: 1,
		kind: "defense-brief",
		markdown,
		sources: [evidence()],
		warnings: [],
		partial,
	});
}

type AgentBehavior = (
	input: PreparationAgentRunInput,
	attempt: number,
	sessionId: string,
) => Promise<string> | string;

function coordinatorHarness(
	behavior: AgentBehavior,
	fixedSnapshot: PaperSnapshot | (() => PaperSnapshot) = snapshot(),
	options: {
		isAgentRunActive?: (sessionId: string) => Promise<boolean>;
		enqueue?: DefensePreparationDependencies["enqueue"];
	} = {},
) {
	const storage = new MemoryPreparationStorage();
	const calls: PreparationAgentRunInput[] = [];
	const cancelledSessions: string[] = [];
	const attempts = new Map<string, number>();
	let sequence = 0;
	let clock = 0;
	let active = 0;
	let maximumActive = 0;
	const runAgent = async (
		input: PreparationAgentRunInput,
	): Promise<PreparationAgentResult> => {
		calls.push(input);
		const count = (attempts.get(input.role) ?? 0) + 1;
		attempts.set(input.role, count);
		const sessionId = `session-${input.role}-${count}`;
		input.onStarted({
			sessionId,
			messageId: `message-${count}`,
			agentId: "agent",
		});
		active += 1;
		maximumActive = Math.max(maximumActive, active);
		try {
			const content = await behavior(input, count, sessionId);
			return {
				sessionId,
				messageId: `message-${count}`,
				agentId: "agent",
				content,
				sources: [],
				usageUsed: 12,
				usageSize: 100,
			};
		} finally {
			active -= 1;
			input.onFinished(sessionId);
		}
	};
	const snapshotDeps: PaperSnapshotDeps = {
		listDirectory: async () => [],
		readText: async () => "",
		fingerprintFile: async () => undefined,
		hashText: async (content) => fakeHash(content),
		now: () => "2026-01-01T00:00:00.000Z",
	};
	const deps: Partial<DefensePreparationDependencies> = {
		createSnapshot: async () =>
			structuredClone(
				typeof fixedSnapshot === "function" ? fixedSnapshot() : fixedSnapshot,
			),
		createSnapshotDeps: () => snapshotDeps,
		createStorage: () => storage,
		runAgent,
		cancelAgent: async (sessionId) => {
			cancelledSessions.push(sessionId);
		},
		isAgentRunActive: options.isAgentRunActive ?? (async () => false),
		enqueue:
			options.enqueue ??
			(async (_input, fn, options) => {
				expect(options).toMatchObject({ concurrency: 1 });
				expect(options.signal).toBeInstanceOf(AbortSignal);
				const controller = new AbortController();
				const cancel = () => controller.abort();
				if (options.signal.aborted) cancel();
				else options.signal.addEventListener("abort", cancel, { once: true });
				return fn({
					id: "background-1",
					signal: controller.signal,
					setProgress: () => undefined,
					setDetail: () => undefined,
				});
			}),
		now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
		newId: () => `id-${++sequence}`,
		hashText: async (content) => fakeHash(content),
	};
	return {
		coordinator: new DefensePreparationCoordinator(deps),
		storage,
		calls,
		attempts,
		cancelledSessions,
		maximumActive: () => maximumActive,
	};
}

beforeEach(() => {
	resetDefensePreparationRuntimeForTests();
});

describe("Voice defense session lease", () => {
	it("only lets the current owner release the active session", () => {
		expect(acquireVoiceDefenseSession("first")).toBe(true);
		expect(isVoiceDefenseSessionActive()).toBe(true);
		expect(acquireVoiceDefenseSession("second")).toBe(false);

		releaseVoiceDefenseSession("wrong");
		expect(isVoiceDefenseSessionActive()).toBe(true);

		releaseVoiceDefenseSession("first");
		expect(isVoiceDefenseSessionActive()).toBe(false);
		expect(acquireVoiceDefenseSession("second")).toBe(true);

		releaseVoiceDefenseSession("first");
		expect(isVoiceDefenseSessionActive()).toBe(true);
		releaseVoiceDefenseSession("second");
		expect(isVoiceDefenseSessionActive()).toBe(false);
	});

	it("rejects empty and whitespace-only lease identifiers", () => {
		expect(acquireVoiceDefenseSession("")).toBe(false);
		expect(acquireVoiceDefenseSession("   ")).toBe(false);
		expect(isVoiceDefenseSessionActive()).toBe(false);
	});

	it("clears a stuck lease so a later acquire can proceed", () => {
		expect(acquireVoiceDefenseSession("orphan")).toBe(true);
		clearVoiceDefenseSessionLease();
		expect(isVoiceDefenseSessionActive()).toBe(false);
		expect(acquireVoiceDefenseSession("next")).toBe(true);
		releaseVoiceDefenseSession("next");
	});
});

describe("paper snapshot", () => {
	it("collects text, PDF, figure, and experiment-data sources within the paper", async () => {
		const reads: string[] = [];
		const fingerprints: string[] = [];
		const directories = new Map<string, FileNode[]>([
			[
				"/vault/papers/demo",
				[
					{
						id: "paper",
						name: "PAPER.md",
						path: "/vault/papers/demo/PAPER.md",
						kind: "file",
					},
					{
						id: "pdf",
						name: "paper.pdf",
						path: "/vault/papers/demo/paper.pdf",
						kind: "file",
					},
					{
						id: "ignore",
						name: "scratch.txt",
						path: "/vault/papers/demo/scratch.txt",
						kind: "file",
					},
					{
						id: "source",
						name: "source",
						path: "/vault/papers/demo/source",
						kind: "directory",
					},
				],
			],
			[
				"/vault/papers/demo/source",
				["main.ltx", "refs.bib", "paper.bbl", "result.png", "metrics.csv"].map(
					(name) => ({
						id: name,
						name,
						path: `/vault/papers/demo/source/${name}`,
						kind: "file" as const,
					}),
				),
			],
		]);
		const result = await createPaperSnapshot(
			{
				vaultRoot: "/vault",
				paperPath: "papers/demo",
				selections: [
					{ text: "selected", sourcePath: "papers/demo/PAPER.md", page: 2 },
				],
			},
			{
				listDirectory: async (_root, path) => directories.get(path) ?? [],
				readText: async (path) => {
					reads.push(path);
					return `content:${path}`;
				},
				fingerprintFile: async (_root, path) => {
					fingerprints.push(path);
					return {
						size: 100,
						modifiedAt: "now",
						sha256: fakeHash(path),
					};
				},
				hashText: async (content) => fakeHash(content),
				now: () => "now",
			},
		);

		expect(result.sources.map((source) => source.path)).toEqual([
			"papers/demo/PAPER.md",
			"papers/demo/paper.pdf",
			"papers/demo/scratch.txt",
			"papers/demo/source/main.ltx",
			"papers/demo/source/metrics.csv",
			"papers/demo/source/paper.bbl",
			"papers/demo/source/refs.bib",
			"papers/demo/source/result.png",
		]);
		expect(reads).not.toContain("/vault/papers/demo/paper.pdf");
		expect(reads).not.toContain("/vault/papers/demo/source/result.png");
		expect(reads).not.toContain("/vault/papers/demo/source/metrics.csv");
		expect(fingerprints).toContain("papers/demo/paper.pdf");
		expect(result.sources.find((source) => source.kind === "pdf")?.sha256).toBe(
			fakeHash("papers/demo/paper.pdf"),
		);
		expect(result.sources.find((source) => source.kind === "image")?.path).toBe(
			"papers/demo/source/result.png",
		);
		expect(result.sources.find((source) => source.kind === "data")?.path).toBe(
			"papers/demo/source/metrics.csv",
		);
		expect(result.snapshotSha256).toHaveLength(64);
		await expect(
			createPaperSnapshot(
				{ vaultRoot: "/vault", paperPath: "../outside" },
				{
					listDirectory: async () => [],
					readText: async () => "",
					fingerprintFile: async () => undefined,
					hashText: async () => "hash",
					now: () => "now",
				},
			),
		).rejects.toThrow(/Vault-relative/);
	});

	it("snapshots multiple selected materials and includes the user instruction in the fingerprint", async () => {
		const files = new Map<string, FileNode[]>([
			[
				"/vault/slides",
				[
					{
						id: "notes",
						name: "talk.md",
						path: "/vault/slides/talk.md",
						kind: "file",
					},
				],
			],
		]);
		const deps: PaperSnapshotDeps = {
			listDirectory: async (_root, path) => files.get(path) ?? [],
			readText: async (path) => `content:${path}`,
			fingerprintFile: async (_root, path) => ({ sha256: fakeHash(path) }),
			hashText: async (content) => fakeHash(content),
			now: () => "now",
		};
		const base = {
			vaultRoot: "/vault",
			paperPath: "slides",
			materials: [
				{ path: "slides", kind: "directory" as const, title: "Slides" },
				{ path: "appendix.pdf", kind: "file" as const, title: "Appendix" },
			],
		};
		const first = await createPaperSnapshot(
			{ ...base, instruction: "Focus on experiments" },
			deps,
		);
		const second = await createPaperSnapshot(
			{ ...base, instruction: "Focus on novelty" },
			deps,
		);
		expect(first.materials).toEqual(base.materials);
		expect(first.sources.map((source) => source.path)).toEqual([
			"appendix.pdf",
			"slides/talk.md",
		]);
		expect(first.instruction).toBe("Focus on experiments");
		expect(first.snapshotSha256).not.toBe(second.snapshotSha256);
	});

	it("detects changed hashes without treating createdAt as content", () => {
		const before = snapshot("3".repeat(64));
		const same = { ...snapshot("3".repeat(64)), createdAt: "later" };
		expect(detectPreparationStaleness(before, same).stale).toBe(false);
		const changed = snapshot("4".repeat(64));
		changed.sources[0] = { ...changed.sources[0], sha256: "5".repeat(64) };
		expect(detectPreparationStaleness(before, changed)).toEqual({
			stale: true,
			changedPaths: [SOURCE],
		});
	});
});

describe("structured output schema", () => {
	it("accepts a valid structured result after an ACP diagnostic warning", () => {
		const raw = [
			"Warning: Skill descriptions were shortened to fit the 2% skills context budget.",
			"",
			analysisOutput(),
		].join("\n");

		expect(
			parseDefenseStructuredOutput("paper-analysis", raw, [SOURCE]).kind,
		).toBe("paper-analysis");
	});

	it.each([
		[ACP_PROVIDER_403_OUTPUT, 403],
		["Config warning: ignored option.\n\nHTTP 503 Service Unavailable", 503],
	])("preserves an ACP provider HTTP diagnostic instead of a JSON parser error", (raw, expectedStatus) => {
		let failure: unknown;
		try {
			parseDefenseStructuredOutput("paper-analysis", raw, [SOURCE]);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(DefenseProviderDiagnosticError);
		expect(failure).toMatchObject({ statusCode: expectedStatus });
		expect((failure as Error).message).toContain(String(expectedStatus));
		expect((failure as Error).message).not.toMatch(
			/Unexpected (?:identifier|token)/,
		);
	});

	it("accepts explicit-selection evidence and rejects paths outside the snapshot", () => {
		const selected = "papers/demo/selection.md";
		const parsed = JSON.parse(analysisOutput());
		const raw = JSON.stringify({
			...parsed,
			sections: parsed.sections.map(
				(section: Record<string, unknown>, index: number) =>
					index === 0
						? { ...section, evidence: [evidence(selected)] }
						: section,
			),
			sources: [evidence(selected)],
		});
		expect(
			parseDefenseStructuredOutput("paper-analysis", raw, [SOURCE, selected])
				.kind,
		).toBe("paper-analysis");
		expect(() =>
			parseDefenseStructuredOutput("paper-analysis", raw, [SOURCE]),
		).toThrow(DefenseOutputValidationError);
		expect(() =>
			parseDefenseStructuredOutput(
				"paper-analysis",
				raw.replaceAll(selected, "../secret.md"),
				["../secret.md"],
			),
		).toThrow(/outside the paper snapshot/);
	});

	it("rejects paper analysis that omits a required topic", () => {
		const value = JSON.parse(analysisOutput());
		value.sections = value.sections.filter(
			(section: { topic: string }) =>
				section.topic !== "limitations-future-work",
		);
		expect(() =>
			parseDefenseStructuredOutput("paper-analysis", JSON.stringify(value), [
				SOURCE,
			]),
		).toThrow(/missing topics: limitations-future-work/);
	});

	it("requires explicit verification and source disclosure", () => {
		const missingVerification = JSON.parse(analysisOutput());
		delete missingVerification.sections[0].verification;
		expect(() =>
			parseDefenseStructuredOutput(
				"paper-analysis",
				JSON.stringify(missingVerification),
				[SOURCE],
			),
		).toThrow(/verification must be verified or unverified/);

		const unsupportedVerified = JSON.parse(analysisOutput());
		unsupportedVerified.sections[0].evidence = [];
		expect(() =>
			parseDefenseStructuredOutput(
				"paper-analysis",
				JSON.stringify(unsupportedVerified),
				[SOURCE],
			),
		).toThrow(/must have evidence or be marked unverified/);

		const missingSources = JSON.parse(analysisOutput());
		missingSources.sources = [];
		expect(() =>
			parseDefenseStructuredOutput(
				"paper-analysis",
				JSON.stringify(missingSources),
				[SOURCE],
			),
		).toThrow(/must include at least one source/);
	});

	it("rejects adversarial review with missing coverage or invalid question fields", () => {
		const missingCategory = JSON.parse(reviewOutput());
		missingCategory.questions = missingCategory.questions.slice(0, -1);
		expect(() =>
			parseDefenseStructuredOutput(
				"adversarial-review",
				JSON.stringify(missingCategory),
				[SOURCE],
			),
		).toThrow(/missing categories: failures-boundaries-reproducibility/);

		const missingDifficulty = JSON.parse(reviewOutput());
		delete missingDifficulty.questions[0].difficulty;
		expect(() =>
			parseDefenseStructuredOutput(
				"adversarial-review",
				JSON.stringify(missingDifficulty),
				[SOURCE],
			),
		).toThrow(/difficulty is unsupported/);

		const missingFollowUp = JSON.parse(reviewOutput());
		missingFollowUp.questions[0].followUps = [];
		expect(() =>
			parseDefenseStructuredOutput(
				"adversarial-review",
				JSON.stringify(missingFollowUp),
				[SOURCE],
			),
		).toThrow(/must contain at least one follow-up/);
	});

	it("rejects absolute, drive-letter, remote, and traversal paths", () => {
		for (const path of [
			"/etc/passwd",
			"\\\\server\\share\\paper.md",
			"C:\\paper.md",
			"remote:session/paper.md",
			"papers/demo/../secret.md",
		]) {
			expect(isSafeVaultRelativePath(path), path).toBe(false);
		}
		expect(isSafeVaultRelativePath(SOURCE)).toBe(true);
	});
});

describe("reusable preparation selection", () => {
	function reusableManifest(input: {
		runId: string;
		status: DefensePreparationManifest["status"];
		snapshotSha256: string;
		paperPath?: string;
		briefPath?: string | null;
		updatedAt?: string;
	}): DefensePreparationManifest {
		const value = createDefensePreparationManifest({
			runId: input.runId,
			snapshot: snapshot(input.snapshotSha256),
			now: input.updatedAt ?? "2026-01-02T00:00:00.000Z",
		});
		value.paperPath = input.paperPath ?? value.paperPath;
		value.snapshot.paperPath = value.paperPath;
		value.status = input.status;
		value.briefPath =
			input.briefPath === undefined
				? `voice-defense/preparations/${input.runId}/defense-brief.md`
				: input.briefPath;
		value.updatedAt = input.updatedAt ?? value.updatedAt;
		return value;
	}

	it("picks the latest matching ready brief and ignores in-flight or failed runs", () => {
		const hash = "a".repeat(64);
		const other = "b".repeat(64);
		const manifests = [
			reusableManifest({
				runId: "older-ready",
				status: "completed",
				snapshotSha256: hash,
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
			reusableManifest({
				runId: "newer-ready",
				status: "ready",
				snapshotSha256: hash,
				updatedAt: "2026-01-03T00:00:00.000Z",
			}),
			reusableManifest({
				runId: "running",
				status: "analyzing",
				snapshotSha256: hash,
			}),
			reusableManifest({
				runId: "failed",
				status: "failed",
				snapshotSha256: hash,
			}),
			reusableManifest({
				runId: "other-hash",
				status: "ready",
				snapshotSha256: other,
			}),
			reusableManifest({
				runId: "no-brief",
				status: "ready",
				snapshotSha256: hash,
				briefPath: null,
			}),
		];
		expect(selectReusablePreparation(manifests, hash)?.runId).toBe(
			"newer-ready",
		);
		expect(selectReusablePreparation(manifests, other)?.runId).toBe(
			"other-hash",
		);
		expect(selectReusablePreparation(manifests, "c".repeat(64))).toBeNull();
		expect(
			selectLatestReusablePreparationForPaper(manifests, "papers/demo")?.runId,
		).toBe("newer-ready");
		expect(
			selectLatestReusablePreparationForPaper(manifests, "papers/missing"),
		).toBeNull();
	});
});

describe("defense preparation coordinator", () => {
	it("does not start ACP preparation while a Voice session is active", () => {
		const harness = coordinatorHarness(async () => analysisOutput());
		expect(acquireVoiceDefenseSession("coordinator-test")).toBe(true);
		expect(() =>
			harness.coordinator.start({
				vaultRoot: "/vault",
				paperPath: "papers/demo",
			}),
		).toThrow(/during a Voice session/);
		expect(hasActiveDefensePreparations()).toBe(false);
	});

	it("cancels a queued run before its worker starts", async () => {
		const enqueue = vi.fn<DefensePreparationDependencies["enqueue"]>(
			async (_input, _worker, options) =>
				new Promise<never>((_resolve, reject) => {
					const cancel = () => reject(new BackgroundTaskCancelledError());
					if (options.signal.aborted) cancel();
					else options.signal.addEventListener("abort", cancel, { once: true });
				}),
		);
		const harness = coordinatorHarness(
			async () => analysisOutput(),
			snapshot(),
			{
				enqueue,
			},
		);
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		expect(hasActiveDefensePreparations()).toBe(true);

		await handle.cancel();
		await expect(handle.completion).rejects.toBeInstanceOf(
			BackgroundTaskCancelledError,
		);
		expect(harness.calls).toHaveLength(0);
		expect(hasActiveDefensePreparations()).toBe(false);
	});

	it("runs two fixed branches concurrently, synthesizes locally, and leaves no child runtime", async () => {
		let observedActiveChild = false;
		const harness = coordinatorHarness(async (input) => {
			observedActiveChild ||= hasActivePreparationChildren();
			await new Promise((resolve) => setTimeout(resolve, 5));
			if (input.role === "paper-analysis") return analysisOutput();
			return reviewOutput();
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
			reasoningEffort: "high",
		});
		const manifest = await handle.completion;

		expect(manifest.status).toBe("awaiting_review");
		expect(manifest.partial).toBe(false);
		expect(harness.maximumActive()).toBe(2);
		expect(observedActiveChild).toBe(true);
		expect(hasActivePreparationChildren()).toBe(false);
		// Synthesis renders locally — only the two analysis branches hit ACP.
		expect(harness.calls.map((call) => call.role)).toEqual([
			"paper-analysis",
			"adversarial-review",
		]);
		for (const call of harness.calls) {
			expect(call.request).toMatchObject({
				workflow: "voice_defense_preparation",
				permissionMode: "restricted",
				autoApprove: false,
				hideFromChatHistory: true,
				reasoningEffort: "high",
			});
			expect(call.target).toBe("papers/demo");
		}
		expect(harness.storage.atomicWrites).toContain(
			preparationManifestPath(handle.runId),
		);
		const storedBrief = harness.storage.files.get(
			preparationBriefPath(handle.runId),
		);
		expect(manifest.nodes.synthesis.status).toBe("succeeded");
		expect(storedBrief).toContain("# Defense Brief");
		expect(storedBrief).toContain("Research map");
		expect(storedBrief).toContain("Risk map");
		expect(manifest.nodes["paper-analysis"].attempts[0]).toMatchObject({
			usageUsed: 12,
			usageSize: 100,
		});
	});

	it("retries one invalid branch once, keeps attempts, and emits an untruncated partial brief", async () => {
		const harness = coordinatorHarness(async (input) => {
			if (input.role === "paper-analysis") return analysisOutput();
			return "not valid JSON";
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
			language: "en",
		});
		const manifest = await handle.completion;

		expect(manifest.status).toBe("awaiting_review");
		expect(manifest.partial).toBe(true);
		expect(manifest.nodes["adversarial-review"].attempts).toHaveLength(2);
		expect(
			manifest.nodes["adversarial-review"].attempts.map((attempt) => ({
				attempt: attempt.attempt,
				status: attempt.status,
			})),
		).toEqual([
			{ attempt: 1, status: "failed" },
			{ attempt: 2, status: "failed" },
		]);
		for (const attempt of [1, 2]) {
			const artifact = JSON.parse(
				harness.storage.files.get(
					preparationArtifactPath(handle.runId, "adversarial-review", attempt),
				) ?? "{}",
			);
			expect(artifact).toMatchObject({
				attempt,
				status: "invalid",
				rawOutput: "not valid JSON",
			});
		}
		const storedBrief = harness.storage.files.get(
			preparationBriefPath(handle.runId),
		);
		expect(storedBrief).toContain("Partial analysis");
		// The locally rendered brief keeps every validated analysis section.
		for (const topic of ANALYSIS_TOPICS) {
			expect(storedBrief).toContain(`${topic} details`);
		}
		const briefArtifact = JSON.parse(
			harness.storage.files.get(
				preparationArtifactPath(handle.runId, "synthesis", 1),
			) ?? "{}",
		);
		expect(briefArtifact).toMatchObject({
			producer: "local-synthesis",
			status: "partial",
		});
		expect(briefArtifact.payload.partial).toBe(true);
	});

	it("preserves provider 403 diagnostics without retrying deterministic rejections", async () => {
		const harness = coordinatorHarness(async () => ACP_PROVIDER_403_OUTPUT);
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		let failure: unknown;
		try {
			await handle.completion;
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(DefensePreparationFailedError);
		const description = preparationFailureDescription(failure);
		expect(description).toContain("unexpected status 403 Forbidden");
		expect(description).toContain("该渠道不允许当前客户端使用");
		expect(description).not.toMatch(/Unexpected (?:identifier|token)/);
		expect(harness.calls).toHaveLength(2);

		const manifest = (failure as DefensePreparationFailedError).manifest;
		for (const role of ["paper-analysis", "adversarial-review"] as const) {
			expect(manifest.nodes[role].attempts).toHaveLength(1);
			expect(manifest.nodes[role].attempts[0]?.error).toContain(
				"unexpected status 403 Forbidden",
			);
			const artifact = JSON.parse(
				harness.storage.files.get(
					preparationArtifactPath(handle.runId, role, 1),
				) ?? "{}",
			);
			expect(artifact).toMatchObject({
				attempt: 1,
				status: "invalid",
				rawOutput: ACP_PROVIDER_403_OUTPUT,
			});
			expect(artifact.error).toContain("unexpected status 403 Forbidden");
			expect(artifact.error).not.toMatch(/Unexpected (?:identifier|token)/);
		}
	});

	it("records an ACP timeout as failed and retries the analysis node", async () => {
		const harness = coordinatorHarness(async (input, attempt) => {
			if (input.role === "paper-analysis" && attempt === 1) {
				throw new Error("ACP node timed out after 10ms");
			}
			if (input.role === "paper-analysis") return analysisOutput();
			if (input.role === "adversarial-review") return reviewOutput();
			return briefOutput("# Complete brief", false);
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		const manifest = await handle.completion;

		expect(manifest.status).toBe("awaiting_review");
		expect(manifest.nodes["paper-analysis"].attempts).toMatchObject([
			{ attempt: 1, status: "failed", error: "ACP node timed out after 10ms" },
			{ attempt: 2, status: "succeeded" },
		]);
	});

	it("locally synthesized brief carries questions, evidence, and the Host partial flag", async () => {
		const harness = coordinatorHarness(async (input) => {
			if (input.role === "paper-analysis") return analysisOutput();
			return reviewOutput();
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		const manifest = await handle.completion;

		expect(manifest.partial).toBe(false);
		const artifact = JSON.parse(
			harness.storage.files.get(
				preparationArtifactPath(handle.runId, "synthesis", 1),
			) ?? "{}",
		);
		expect(artifact).toMatchObject({
			producer: "local-synthesis",
			status: "valid",
		});
		expect(artifact.payload.partial).toBe(false);
		// The composed payload passes the same schema gate as agent output did.
		expect(
			parseDefenseStructuredOutput(
				"synthesis",
				JSON.stringify(artifact.payload),
				[SOURCE],
			).kind,
		).toBe("defense-brief");
		const brief =
			harness.storage.files.get(preparationBriefPath(handle.runId)) ?? "";
		expect(brief).toContain("### Q1");
		expect(brief).toContain("Question about motivation?");
		expect(brief).toContain("Answer points");
		expect(brief).toContain(SOURCE);
	});

	it("persists failed state and rejects without synthesis when both branches fail", async () => {
		const harness = coordinatorHarness(async () => {
			throw new Error("provider unavailable");
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		await expect(handle.completion).rejects.toBeInstanceOf(
			DefensePreparationFailedError,
		);
		const manifest = JSON.parse(
			harness.storage.files.get(preparationManifestPath(handle.runId)) ?? "{}",
		) as DefensePreparationManifest;
		expect(manifest.status).toBe("failed");
		expect(manifest.nodes.synthesis.attempts).toEqual([]);
		expect(harness.calls).toHaveLength(4);
	});

	it("fails as stale when a paper source changes before synthesis", async () => {
		let current = snapshot();
		const harness = coordinatorHarness(
			async (input) => {
				if (input.role === "adversarial-review") {
					current = snapshot("9".repeat(64));
					current.sources[0] = {
						...current.sources[0],
						sha256: "8".repeat(64),
					};
					return reviewOutput();
				}
				return analysisOutput();
			},
			() => current,
		);
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});

		await expect(handle.completion).rejects.toMatchObject({
			name: "PreparationStaleError",
		});
		const manifest = JSON.parse(
			harness.storage.files.get(preparationManifestPath(handle.runId)) ?? "{}",
		) as DefensePreparationManifest;
		expect(manifest.stale).toBe(true);
		expect(manifest.status).toBe("failed");
		expect(manifest.nodes.synthesis.attempts).toEqual([]);
	});

	it("rejects a validated artifact that was modified before synthesis", async () => {
		let harness: ReturnType<typeof coordinatorHarness>;
		harness = coordinatorHarness(async (input) => {
			if (input.role === "paper-analysis") return analysisOutput();
			if (input.role === "adversarial-review") {
				await vi.waitFor(() => {
					expect(
						[...harness.storage.files.keys()].some((path) =>
							path.includes("paper-analysis.attempt-1.json"),
						),
					).toBe(true);
				});
				const path = [...harness.storage.files.keys()].find((candidate) =>
					candidate.includes("paper-analysis.attempt-1.json"),
				);
				if (!path) throw new Error("analysis artifact missing");
				const artifact = JSON.parse(harness.storage.files.get(path) ?? "{}");
				artifact.payload.overview = "externally modified";
				harness.storage.files.set(path, JSON.stringify(artifact));
				return reviewOutput();
			}
			throw new Error("synthesis must not run with a modified artifact");
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});

		await expect(handle.completion).rejects.toBeInstanceOf(
			DefensePreparationFailedError,
		);
		expect(harness.calls.map((call) => call.role)).not.toContain("synthesis");
		const manifest = JSON.parse(
			harness.storage.files.get(preparationManifestPath(handle.runId)) ?? "{}",
		) as DefensePreparationManifest;
		expect(manifest.nodes.synthesis.status).toBe("failed");
		expect(manifest.nodes.synthesis.attempts[0]?.error).toMatch(/hash/);
	});

	it("cancels every active child session", async () => {
		const harness = coordinatorHarness(
			(input) =>
				new Promise<string>((_resolve, reject) => {
					const cancel = () =>
						reject(new DOMException("Aborted", "AbortError"));
					if (input.signal.aborted) cancel();
					else input.signal.addEventListener("abort", cancel, { once: true });
				}),
		);
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		await vi.waitFor(() => expect(harness.calls).toHaveLength(2));
		expect(hasActivePreparationChildren()).toBe(true);
		await handle.cancel();
		await expect(handle.completion).rejects.toThrow(
			/background task cancelled/,
		);
		expect(harness.cancelledSessions.sort()).toEqual([
			"session-adversarial-review-1",
			"session-paper-analysis-1",
		]);
		expect(hasActivePreparationChildren()).toBe(false);
	});

	it("resumes only failed work and synthesis while preserving successful attempts", async () => {
		const base = snapshot();
		const manifest = createDefensePreparationManifest({
			runId: "resume-run",
			snapshot: base,
			now: "2026-01-01T00:00:00.000Z",
		});
		manifest.status = "failed";
		manifest.nodes["paper-analysis"] = {
			...manifest.nodes["paper-analysis"],
			status: "succeeded",
			artifactId: "analysis-artifact",
			artifactPath: preparationArtifactPath(
				manifest.runId,
				"paper-analysis",
				1,
			),
			attempts: [
				{
					attempt: 1,
					status: "succeeded",
					startedAt: "a",
					finishedAt: "b",
					artifactId: "analysis-artifact",
					artifactPath: preparationArtifactPath(
						manifest.runId,
						"paper-analysis",
						1,
					),
				},
			],
		};
		manifest.nodes["adversarial-review"].status = "failed";
		manifest.nodes["adversarial-review"].attempts = [
			{
				attempt: 1,
				status: "failed",
				startedAt: "a",
				finishedAt: "b",
				error: "crash",
			},
		];
		const harness = coordinatorHarness(async (input) => {
			if (input.role === "adversarial-review") return reviewOutput();
			throw new Error("successful analysis must not rerun");
		}, base);
		harness.storage.files.set(
			preparationManifestPath(manifest.runId),
			`${JSON.stringify(manifest)}\n`,
		);
		const analysisPayload = JSON.parse(analysisOutput());
		harness.storage.files.set(
			manifest.nodes["paper-analysis"].artifactPath as string,
			`${JSON.stringify({
				schemaVersion: 1,
				artifactId: "analysis-artifact",
				runId: manifest.runId,
				taskId: manifest.nodes["paper-analysis"].taskId,
				attempt: 1,
				kind: "paper-analysis",
				producer: "agent",
				contentPath: manifest.nodes["paper-analysis"].artifactPath,
				contentSha256: fakeHash(JSON.stringify(analysisPayload)),
				sources: [evidence()],
				status: "valid",
				warnings: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				payload: analysisPayload,
			})}\n`,
		);

		const resumed = await harness.coordinator.resume({
			runId: manifest.runId,
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		expect(resumed.status).toBe("awaiting_review");
		// Synthesis is local: resume only re-runs the failed analysis branch.
		expect(harness.calls.map((call) => call.role)).toEqual([
			"adversarial-review",
		]);
		expect(resumed.nodes["paper-analysis"].attempts).toHaveLength(1);
		expect(resumed.nodes["adversarial-review"].attempts).toHaveLength(2);
		expect(resumed.nodes.synthesis.status).toBe("succeeded");
	});

	it("atomically confirms edited material and records completion", async () => {
		const harness = coordinatorHarness(async (input) => {
			if (input.role === "paper-analysis") return analysisOutput();
			if (input.role === "adversarial-review") return reviewOutput();
			return briefOutput("# Draft", false);
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		await handle.completion;
		const ready = await harness.coordinator.confirm(
			"/vault",
			handle.runId,
			"# User edited",
		);
		expect(ready.status).toBe("ready");
		expect(ready.review).toMatchObject({ edited: true });
		expect(harness.storage.files.get(preparationBriefPath(handle.runId))).toBe(
			"# User edited",
		);
		const completed = await harness.coordinator.complete(
			"/vault",
			handle.runId,
		);
		expect(completed.status).toBe("completed");
		expect(completed.review?.completedAt).toBeTruthy();
	});

	it("refuses confirmation while a persisted ACP session is still active", async () => {
		let hostActive = false;
		const harness = coordinatorHarness(
			async (input) => {
				if (input.role === "paper-analysis") return analysisOutput();
				if (input.role === "adversarial-review") return reviewOutput();
				return briefOutput("# Draft", false);
			},
			snapshot(),
			{ isAgentRunActive: async () => hostActive },
		);
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		await handle.completion;
		hostActive = true;

		await expect(
			harness.coordinator.confirm("/vault", handle.runId, "# Confirmed"),
		).rejects.toThrow(/ACP runtime is still active/);
		hostActive = false;
		await expect(
			harness.coordinator.confirm("/vault", handle.runId, "# Confirmed"),
		).resolves.toMatchObject({ status: "ready" });
	});

	it("confirms a ready brief without re-hashing when skipSnapshotFreshness is set", async () => {
		let current = snapshot();
		const harness = coordinatorHarness(
			async (input) => {
				if (input.role === "paper-analysis") return analysisOutput();
				if (input.role === "adversarial-review") return reviewOutput();
				return briefOutput("# Draft", false);
			},
			() => current,
		);
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		await handle.completion;
		current = snapshot("9".repeat(64));
		await expect(
			harness.coordinator.confirm("/vault", handle.runId, "# Confirmed"),
		).rejects.toBeInstanceOf(PreparationStaleError);
		await expect(
			harness.coordinator.confirm("/vault", handle.runId, "# Confirmed", {
				skipSnapshotFreshness: true,
			}),
		).resolves.toMatchObject({ status: "ready" });
	});

	it("drops leftover child sessions that Host already finished before confirming", async () => {
		const harness = coordinatorHarness(async (input) => {
			if (input.role === "paper-analysis") return analysisOutput();
			if (input.role === "adversarial-review") return reviewOutput();
			return briefOutput("# Draft", false);
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		await handle.completion;
		await vi.waitFor(() => expect(hasActiveDefensePreparations()).toBe(false));
		registerDefensePreparationRuntime({
			runId: handle.runId,
			vaultRoot: "/vault",
			paperPath: "papers/demo",
			manifest: null,
			activeChildSessionIds: ["ghost-session"],
			cancelRequested: false,
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(hasActiveDefensePreparations()).toBe(true);
		expect(hasActivePreparationChildren()).toBe(true);
		await expect(
			harness.coordinator.confirm("/vault", handle.runId, "# Confirmed"),
		).resolves.toMatchObject({ status: "ready" });
		expect(hasActiveDefensePreparations()).toBe(false);
		expect(hasActivePreparationChildren()).toBe(false);
	});

	it("still refuses confirmation when leftover children are Host-active", async () => {
		let hostActive = false;
		const harness = coordinatorHarness(
			async (input) => {
				if (input.role === "paper-analysis") return analysisOutput();
				if (input.role === "adversarial-review") return reviewOutput();
				return briefOutput("# Draft", false);
			},
			snapshot(),
			{
				isAgentRunActive: async (sessionId) =>
					hostActive && sessionId === "ghost-session",
			},
		);
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		await handle.completion;
		await vi.waitFor(() => expect(hasActiveDefensePreparations()).toBe(false));
		registerDefensePreparationRuntime({
			runId: handle.runId,
			vaultRoot: "/vault",
			paperPath: "papers/demo",
			manifest: null,
			activeChildSessionIds: ["ghost-session"],
			cancelRequested: false,
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		hostActive = true;
		await expect(
			harness.coordinator.confirm("/vault", handle.runId, "# Confirmed"),
		).rejects.toThrow(/ACP runtime is still active/);
	});

	it("force-confirms even when leftover children are still Host-active", async () => {
		const harness = coordinatorHarness(
			async (input) => {
				if (input.role === "paper-analysis") return analysisOutput();
				if (input.role === "adversarial-review") return reviewOutput();
				return briefOutput("# Draft", false);
			},
			snapshot(),
			{ isAgentRunActive: async () => true },
		);
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		await handle.completion;
		await vi.waitFor(() => expect(hasActiveDefensePreparations()).toBe(false));
		registerDefensePreparationRuntime({
			runId: handle.runId,
			vaultRoot: "/vault",
			paperPath: "papers/demo",
			manifest: null,
			activeChildSessionIds: ["ghost-session"],
			cancelRequested: false,
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		await expect(
			harness.coordinator.confirm("/vault", handle.runId, "# Forced", {
				force: true,
			}),
		).resolves.toMatchObject({ status: "ready" });
		expect(hasActiveDefensePreparations()).toBe(false);
	});

	it("recovers a completed brief whose awaiting-review checkpoint was interrupted", async () => {
		const harness = coordinatorHarness(async (input) => {
			if (input.role === "paper-analysis") return analysisOutput();
			if (input.role === "adversarial-review") return reviewOutput();
			return briefOutput("# Recoverable", false);
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		const completed = await handle.completion;
		await vi.waitFor(() => expect(hasActiveDefensePreparations()).toBe(false));
		const interrupted = { ...completed, status: "synthesizing" as const };
		harness.storage.files.set(
			preparationManifestPath(handle.runId),
			`${JSON.stringify(interrupted)}\n`,
		);

		const recovered = await harness.coordinator.refresh("/vault", handle.runId);
		expect(recovered.status).toBe("awaiting_review");
		expect(recovered.briefPath).toBe(preparationBriefPath(handle.runId));
	});

	it("finds a reusable completed run by snapshot fingerprint", async () => {
		const paperSnapshot = snapshot();
		const harness = coordinatorHarness(async (input) => {
			if (input.role === "paper-analysis") return analysisOutput();
			return reviewOutput();
		}, paperSnapshot);
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
		});
		const manifest = await handle.completion;
		expect(manifest.status).toBe("awaiting_review");
		expect(manifest.briefPath).toBeTruthy();

		const reusable = await harness.coordinator.findReusable(
			"/vault",
			paperSnapshot.snapshotSha256,
		);
		expect(reusable?.runId).toBe(manifest.runId);
		expect(
			await harness.coordinator.findReusable("/vault", "0".repeat(64)),
		).toBeNull();
		expect(
			await harness.coordinator.findLatestReusableForPaper(
				"/vault",
				"papers/demo",
			),
		).toMatchObject({ runId: manifest.runId });
		expect(
			await harness.coordinator.findLatestReusableForPaper(
				"/vault",
				"papers/other",
			),
		).toBeNull();
	});
});

describe("preparation prompts", () => {
	it("requires complete analysis and review coverage using an allowed source path", () => {
		const materialSnapshot = snapshot();
		materialSnapshot.instruction = "Focus on experimental design";
		const commonEnvelope = {
			schemaVersion: 1 as const,
			runId: "run",
			taskId: "task",
			attempt: 1,
			objective: "prepare",
			paperSnapshot: materialSnapshot,
			inputArtifacts: [],
			outputKind: "paper-analysis" as const,
			language: "en" as const,
		};
		const analysis = buildAnalysisPrompt({
			...commonEnvelope,
			role: "paper-analysis",
		});
		for (const topic of ANALYSIS_TOPICS) expect(analysis).toContain(topic);
		expect(analysis).toContain(`"path": "${SOURCE}"`);
		expect(analysis).toContain("Focus on experimental design");
		expect(analysis).toContain("selected material bundle");

		const review = buildReviewPrompt({
			...commonEnvelope,
			role: "adversarial-review",
			outputKind: "review",
		});
		for (const category of REVIEW_CATEGORIES)
			expect(review).toContain(category);
		expect(review).toContain('"difficulty": "basic"');
		expect(review).toContain('"difficulty": "advanced"');
	});

	it("requires empty evidence arrays when the snapshot has no citable path", () => {
		const noSources = snapshot();
		noSources.sources = [];
		noSources.selections = [{ text: "Unattributed excerpt" }];
		const prompt = buildAnalysisPrompt({
			schemaVersion: 1,
			runId: "run",
			taskId: "task",
			attempt: 1,
			role: "paper-analysis",
			objective: "analyze",
			paperSnapshot: noSources,
			inputArtifacts: [],
			outputKind: "paper-analysis",
			language: "en",
		});
		expect(prompt).toContain("Every evidence and sources array must be empty");
		expect(prompt).toContain('"evidence": []');
		expect(prompt).toContain('"sources": []');

		const value = JSON.parse(analysisOutput());
		value.sections = value.sections.map((section: Record<string, unknown>) => ({
			...section,
			verification: "unverified",
			evidence: [],
		}));
		value.sources = [];
		value.warnings = ["No citable source path is available."];
		expect(
			parseDefenseStructuredOutput("paper-analysis", JSON.stringify(value), [])
				.kind,
		).toBe("paper-analysis");
	});

	it("local synthesis does not truncate long validated content", async () => {
		const longContent = "evidence ".repeat(10_000);
		const value = JSON.parse(analysisOutput());
		value.sections = value.sections.map((section: Record<string, unknown>) => ({
			...section,
			content: longContent,
		}));
		const harness = coordinatorHarness(async (input) => {
			if (input.role === "paper-analysis") return JSON.stringify(value);
			return "not valid JSON";
		});
		const handle = harness.coordinator.start({
			vaultRoot: "/vault",
			paperPath: "papers/demo",
			language: "en",
		});
		const manifest = await handle.completion;
		expect(manifest.partial).toBe(true);
		const brief =
			harness.storage.files.get(preparationBriefPath(handle.runId)) ?? "";
		expect(brief).toContain(longContent.trim());
	});
});
