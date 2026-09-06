import { beforeEach, describe, expect, it } from "vitest";
import type { AgentListResponse, CatalogScanResponse } from "@/lib/agent";
import {
	agentHasContent,
	agentTextFromParts,
	appendStreamPart,
	applyToolToLines,
	applyToolToParts,
	buildLocalTranscriptPrompt,
	buildOptions,
	type ChatLine,
	dedupeModelsClient,
	elicitationContentFromAnswers,
	ensureModelsInclude,
	errorChatLine,
	errorText,
	failIncompleteTools,
	formatAskUserAnswers,
	isBackgroundWorkflowHistoryTitle,
	isPendingAskUserToolStatus,
	parseAskUserQuestions,
	providerSessionIdForHistoryLoad,
	questionsFromAskUserDtos,
	questionsFromElicitationFields,
	resolveSelected,
	shouldDeferSessionEvent,
	upsertChatSessionTurn,
	upsertPlanPart,
} from "@/lib/agent/chat-state";
import { resetAgentChatIds } from "@/lib/pdf-visual/ids";

beforeEach(() => {
	resetAgentChatIds();
});

describe("errorChatLine / errorText", () => {
	it("builds a stable error line shape", () => {
		const line = errorChatLine("boom");
		expect(line).toEqual({
			id: "err-1",
			kind: "error",
			text: "boom",
		});
	});

	it("coerces thrown values", () => {
		expect(errorText(new Error("x"))).toBe("x");
		expect(errorText("y")).toBe("y");
	});
});

describe("stream / tool / plan parts", () => {
	it("merges consecutive same-kind stream chunks", () => {
		let parts = appendStreamPart([], "text", "hello");
		parts = appendStreamPart(parts, "text", " world");
		expect(parts).toHaveLength(1);
		expect(parts[0]).toMatchObject({ type: "text", text: "hello world" });
	});

	it("starts a new part when kind switches", () => {
		let parts = appendStreamPart([], "reasoning", "think");
		parts = appendStreamPart(parts, "text", "answer");
		expect(parts.map((p) => p.type)).toEqual(["reasoning", "text"]);
	});

	it("upserts tools by id without reordering", () => {
		let parts = appendStreamPart([], "text", "before");
		parts = applyToolToParts(parts, {
			id: "t1",
			title: "Read",
			status: "in_progress",
		});
		parts = appendStreamPart(parts, "text", "after");
		parts = applyToolToParts(parts, {
			id: "t1",
			status: "completed",
			output: "ok",
		});
		expect(parts).toHaveLength(3);
		expect(parts[1]).toMatchObject({
			type: "tool",
			tool: { id: "t1", status: "completed", output: "ok" },
		});
	});

	it("applies a late tool update to the completed turn that owns its id", () => {
		const lines: ChatLine[] = [
			{
				id: "a1",
				kind: "agent",
				streaming: false,
				parts: [
					{
						type: "tool",
						id: "p1",
						tool: {
							id: "t1",
							title: "terminal: pwd",
							kind: "execute",
							status: "failed",
						},
					},
				],
			},
		];

		const lateProgress = applyToolToLines(lines, {
			id: "t1",
			status: "in_progress",
			output: "partial",
		});
		expect(lateProgress).toMatchObject([
			{ parts: [{ tool: { status: "failed", output: "partial" } }] },
		]);
		const completed = applyToolToLines(lateProgress, {
			id: "t1",
			status: "completed",
			output: "ok",
		});
		expect(completed).toMatchObject([
			{
				parts: [{ tool: { id: "t1", status: "completed", output: "ok" } }],
			},
		]);
		expect(
			applyToolToLines(completed, {
				id: "t1",
				status: "pending",
				output: "late output",
			}),
		).toMatchObject([
			{ parts: [{ tool: { status: "completed", output: "late output" } }] },
		]);
		expect(
			applyToolToLines(lines, { id: "unknown", status: "completed" }),
		).toBe(lines);
	});

	it("fails only unfinished tools when a turn ends", () => {
		const parts = [
			{
				type: "tool" as const,
				id: "p1",
				tool: {
					id: "t1",
					title: "Pending",
					kind: "execute",
					status: "in_progress" as const,
				},
			},
			{
				type: "tool" as const,
				id: "p2",
				tool: {
					id: "t2",
					title: "Done",
					kind: "read",
					status: "completed" as const,
				},
			},
		];

		expect(failIncompleteTools(parts)).toMatchObject([
			{ tool: { id: "t1", status: "failed" } },
			{ tool: { id: "t2", status: "completed" } },
		]);
	});

	it("keeps an answered ask-user tool completed when its blocked turn cancels", () => {
		const lines: ChatLine[] = [
			{
				id: "a1",
				kind: "agent",
				streaming: true,
				parts: [
					{
						type: "tool",
						id: "p1",
						tool: {
							id: "ask-1",
							title: "Question",
							kind: "other",
							status: "pending",
						},
					},
				],
			},
		];
		const answered = applyToolToLines(lines, {
			id: "ask-1",
			status: "completed",
		});
		const turn = answered[0];
		expect(turn?.kind).toBe("agent");
		if (turn?.kind !== "agent") throw new Error("expected agent turn");

		expect(failIncompleteTools(turn.parts)).toMatchObject([
			{ tool: { id: "ask-1", status: "completed" } },
		]);
	});

	it("keeps a single plan part", () => {
		let parts = upsertPlanPart(
			[],
			[{ content: "a", status: "pending", priority: "medium" }],
		);
		parts = upsertPlanPart(parts, [
			{ content: "b", status: "completed", priority: "high" },
		]);
		expect(parts).toHaveLength(1);
		expect(parts[0]).toMatchObject({
			type: "plan",
			entries: [{ content: "b" }],
		});
	});

	it("detects content and joins text parts", () => {
		const parts = appendStreamPart(
			appendStreamPart([], "text", "a"),
			"text",
			"b",
		);
		expect(agentHasContent(parts)).toBe(true);
		expect(agentTextFromParts(parts)).toBe("ab");
		expect(agentHasContent([])).toBe(false);
	});
});

describe("AskUserQuestion tool input", () => {
	it("treats pending and in_progress as interactive ask-user tool status", () => {
		expect(isPendingAskUserToolStatus("pending")).toBe(true);
		expect(isPendingAskUserToolStatus("in_progress")).toBe(true);
		expect(isPendingAskUserToolStatus(null)).toBe(true);
		expect(isPendingAskUserToolStatus("completed")).toBe(false);
		expect(isPendingAskUserToolStatus("failed")).toBe(false);
	});

	it("parses Codex variant selectable questions and formats answers", () => {
		const questions = parseAskUserQuestions({
			variant: "AskUserQuestion",
			questions: [
				{
					question: "Which scope should I use?",
					options: [
						{ label: "Paper", description: "Only the open paper" },
						{ label: "Vault" },
					],
				},
			],
		});

		expect(questions).toEqual([
			{
				question: "Which scope should I use?",
				options: [
					{ label: "Paper", description: "Only the open paper" },
					{ label: "Vault", description: undefined },
				],
				allowOther: false,
			},
		]);
		expect(formatAskUserAnswers(questions ?? [], ["Paper"])).toBe(
			"Question: Which scope should I use?\nAnswer: Paper",
		);
	});

	it("parses Claude AskUserQuestion shape (header + multiSelect + Other)", () => {
		const questions = parseAskUserQuestions({
			questions: [
				{
					question: "Which authentication method should we use?",
					header: "Auth method",
					multiSelect: false,
					options: [
						{ label: "OAuth 2.0", description: "Industry standard" },
						{ label: "JWT", description: "Stateless" },
					],
				},
				{
					question: "Which features do you want?",
					header: "Features",
					multiSelect: true,
					options: [
						{ label: "Auto-scaling", description: "Scale out" },
						{ label: "Monitoring", description: "Metrics" },
					],
				},
			],
		});
		expect(questions).toHaveLength(2);
		expect(questions?.[0]).toMatchObject({
			question: "Which authentication method should we use?",
			header: "Auth method",
			allowOther: true,
		});
		expect(questions?.[0]?.multiSelect).toBeUndefined();
		expect(questions?.[1]).toMatchObject({
			header: "Features",
			multiSelect: true,
			allowOther: true,
		});
	});

	it("parses OpenCode question tool shape (multiple + custom)", () => {
		const questions = parseAskUserQuestions({
			questions: [
				{
					question: "Preferred UI language?",
					header: "Language",
					multiple: false,
					custom: true,
					options: [
						{ label: "Chinese", description: "中文" },
						{ label: "English", description: "EN" },
						// Synthetic Other is stripped when custom is on.
						{ label: "Other", description: "Type your own" },
					],
				},
			],
		});
		expect(questions).toEqual([
			{
				question: "Preferred UI language?",
				header: "Language",
				options: [
					{ label: "Chinese", description: "中文" },
					{ label: "English", description: "EN" },
				],
				allowOther: true,
			},
		]);
	});

	it("parses Grok-shaped multi_select questions", () => {
		const questions = parseAskUserQuestions({
			questions: [
				{
					question: "Pick targets",
					multi_select: true,
					options: [
						{ label: "A", description: "one", preview: "preview-a" },
						{ label: "B", description: "two" },
					],
				},
			],
		});
		expect(questions?.[0]).toMatchObject({
			question: "Pick targets",
			multiSelect: true,
			allowOther: true,
		});
		expect(questions?.[0]?.options[0]?.description).toBe("one");
	});

	it("folds Claude free-text companion questions into the previous page Other", () => {
		const questions = parseAskUserQuestions({
			questions: [
				{
					question: "Which language?",
					header: "Lang",
					options: [
						{ label: "中文", description: "Chinese" },
						{ label: "English", description: "EN" },
						{ label: "Other", description: "Type your own" },
					],
				},
				// Model-emitted free-text page — must not be a second flip page.
				{
					question: "Please type your own answer",
					header: "Other",
					options: [],
				},
			],
		});
		expect(questions).toHaveLength(1);
		expect(questions?.[0]).toMatchObject({
			question: "Which language?",
			allowOther: true,
		});
		expect(questions?.[0]?.options.map((o) => o.label)).toEqual([
			"中文",
			"English",
		]);
	});

	it("strips 其他 / Type your own option labels into allowOther", () => {
		const questions = parseAskUserQuestions({
			questions: [
				{
					question: "Pick one",
					options: [
						{ label: "A" },
						{ label: "其他" },
						{ label: "Type your own answer" },
					],
				},
			],
		});
		expect(questions).toHaveLength(1);
		expect(questions?.[0]?.options).toEqual([
			{ label: "A", description: undefined },
		]);
		expect(questions?.[0]?.allowOther).toBe(true);
	});

	it("leaves malformed or unrelated tools on the generic UI", () => {
		expect(parseAskUserQuestions({ variant: "Other", questions: [] })).toBe(
			null,
		);
		expect(
			parseAskUserQuestions('{"variant":"AskUserQuestion","questions":[]}'),
		).toBe(null);
		// Shell-like payloads must not become ask-user forms.
		expect(
			parseAskUserQuestions({
				command: "ls",
				questions: [
					{
						question: "noop",
						options: [{ label: "x" }],
					},
				],
			}),
		).toBe(null);
	});

	it("maps Grok ask-user DTOs into form pages", () => {
		const questions = questionsFromAskUserDtos([
			{
				question: "Preferred language?",
				multiSelect: false,
				allowOther: true,
				options: [
					{ label: "Chinese", description: "中文" },
					{ label: "English" },
				],
			},
			{
				question: "Pick features",
				multiSelect: true,
				allowOther: true,
				options: [{ label: "A" }, { label: "B" }],
			},
		]);
		expect(questions).toHaveLength(2);
		expect(questions[0]).toMatchObject({
			question: "Preferred language?",
			allowOther: true,
		});
		expect(questions[0]?.multiSelect).toBeUndefined();
		expect(questions[1]).toMatchObject({
			multiSelect: true,
			allowOther: true,
		});
	});

	it("maps form elicitation fields and merges Codex Other free-text into one page", () => {
		const questions = questionsFromElicitationFields([
			{
				id: "lang",
				title: "Language",
				description: "Which language?",
				required: true,
				kind: "select",
				options: [
					{ value: "zh", title: "中文为主", description: "默认中文" },
					{ value: "en", title: "英文为主" },
				],
			},
			{
				id: "lang__other",
				title: "Other",
				description:
					"Type your own answer instead of choosing an option above.",
				required: false,
				kind: "text",
				options: [],
				isOtherAnswer: true,
				parentFieldId: "lang",
			},
			{
				id: "notes",
				title: "Notes",
				description: "Anything else?",
				required: false,
				kind: "text",
				options: [],
			},
		]);
		expect(questions).toHaveLength(2);
		expect(questions[0]).toMatchObject({
			id: "lang",
			question: "Which language?",
			allowOther: true,
			otherFieldId: "lang__other",
			required: true,
		});
		expect(questions[0]?.options).toHaveLength(2);
		expect(questions[1]).toMatchObject({
			id: "notes",
			question: "Anything else?",
			allowOther: true,
			otherFieldId: "notes",
			required: false,
		});
		// Option pick → primary id; free-text Other → __other key.
		expect(elicitationContentFromAnswers(questions, ["中文为主", ""])).toEqual({
			lang: "zh",
		});
		expect(
			elicitationContentFromAnswers(questions, ["自定义语言", "x"]),
		).toEqual({
			lang__other: "自定义语言",
			notes: "x",
		});
	});

	it("merges elicitation Other without meta (Codex boilerplate description)", () => {
		// No isOtherAnswer / parentFieldId / __other id — only the stock description.
		const questions = questionsFromElicitationFields([
			{
				id: "q0",
				title: "Language",
				description: "Which language?",
				required: true,
				kind: "select",
				options: [
					{ value: "zh", title: "中文" },
					{ value: "en", title: "English" },
				],
			},
			{
				id: "q0_free",
				title: "q0_free",
				description:
					"Type your own answer instead of choosing an option above (optional).",
				required: false,
				kind: "text",
				options: [],
			},
			{
				id: "q1",
				title: "Scope",
				description: "Which scope?",
				required: true,
				kind: "select",
				options: [{ value: "paper", title: "Paper" }],
			},
			{
				id: "q1_free",
				title: "q1_free",
				description:
					"Type your own answer instead of choosing an option above (optional).",
				required: false,
				kind: "text",
				options: [],
			},
		]);
		expect(questions).toHaveLength(2);
		expect(questions[0]).toMatchObject({
			id: "q0",
			question: "Which language?",
			allowOther: true,
			otherFieldId: "q0_free",
		});
		expect(questions[1]).toMatchObject({
			id: "q1",
			question: "Which scope?",
			allowOther: true,
			otherFieldId: "q1_free",
		});
		// Free-text answers write to companion field ids.
		expect(
			elicitationContentFromAnswers(questions, ["自定义", "Paper"]),
		).toEqual({
			q0_free: "自定义",
			q1: "paper",
		});
	});
});

describe("buildOptions / resolveSelected", () => {
	const registry: AgentListResponse = {
		agents: [
			{
				id: "reg-1",
				name: "Reg",
				template: "custom",
				command: "x",
				args: [],
				env: {},
				available: true,
			},
		],
		defaultId: "reg-1",
		enabled: true,
	};

	const catalog: CatalogScanResponse = {
		entries: [
			{
				templateId: "claude-acp",
				name: "Claude",
				description: "",
				command: "claude",
				args: [],
				installHint: "",
				binaryAvailable: true,
				acpCommandAvailable: true,
				acpStatus: "ready",
				registeredId: "claude-1",
				isDefault: true,
			},
			{
				templateId: "missing",
				name: "Missing",
				description: "",
				command: "nope",
				args: [],
				installHint: "",
				binaryAvailable: false,
				acpCommandAvailable: false,
				acpStatus: "missing",
				isDefault: false,
			},
		],
		customAgents: [],
		defaultId: "claude-1",
		enabled: true,
		proxyEnabled: false,
		proxyUrl: "",
	};

	it("omits unavailable catalog entries", () => {
		const opts = buildOptions(registry, catalog);
		expect(opts.map((o) => o.name)).toEqual(["Claude", "Reg"]);
		expect(opts.find((o) => o.name === "Missing")).toBeUndefined();
	});

	it("prefers selected id then default", () => {
		const opts = buildOptions(registry, catalog);
		expect(resolveSelected(opts, "reg-1", registry)?.id).toBe("reg-1");
		expect(resolveSelected(opts, null, registry)?.isDefault).toBe(true);
	});
});

describe("dedupeModelsClient", () => {
	it("dedupes by id and display name", () => {
		const out = dedupeModelsClient([
			{ id: "a", name: "Alpha" },
			{ id: "a", name: "Alpha copy" },
			{ id: "b", name: "Alpha" },
			{ id: " c ", name: "  Gamma  " },
		]);
		expect(out).toEqual([
			{ id: "a", name: "Alpha", group: undefined },
			{ id: "c", name: "Gamma", group: undefined },
		]);
	});
});

describe("ensureModelsInclude", () => {
	it("prepends free-form ids missing from the catalog", () => {
		const out = ensureModelsInclude(
			[
				{ id: "gpt-5", name: "GPT-5" },
				{ id: "gpt-4.1", name: "GPT-4.1" },
			],
			["deepseek-chat", "gpt-5", "  ", null],
			"Custom",
		);
		expect(out[0]).toEqual({
			id: "deepseek-chat",
			name: "deepseek-chat",
			group: "Custom",
		});
		expect(out.map((m) => m.id)).toEqual(["deepseek-chat", "gpt-5", "gpt-4.1"]);
	});
});

describe("isBackgroundWorkflowHistoryTitle", () => {
	it("hides paper-reader workflow titles", () => {
		expect(
			isBackgroundWorkflowHistoryTitle("agentero paper-reader notes"),
		).toBe(true);
		expect(isBackgroundWorkflowHistoryTitle("Summarize this paper")).toBe(
			false,
		);
	});

	it("hides visual-annotation system prompts from history list", () => {
		const title = `You are reviewing 1 visual annotation from a research paper PDF.

## Annotation 1
User comment: 这里最值得读的是什么?`;
		expect(isBackgroundWorkflowHistoryTitle(title)).toBe(true);
		expect(isBackgroundWorkflowHistoryTitle("这里最值得读的是什么?")).toBe(
			false,
		);
	});
});

describe("providerSessionIdForHistoryLoad", () => {
	it("uses the provider id instead of the Agentero runtime id", () => {
		expect(
			providerSessionIdForHistoryLoad({
				id: "runtime-v4",
				agentId: "codex",
				source: "local",
				title: "Earlier conversation",
				agentName: "Codex",
				startedAt: "",
				lines: [],
				status: "completed",
				providerSessionId: "provider-v7",
			}),
		).toBe("provider-v7");
	});

	it("falls back to the history id for provider-indexed sessions", () => {
		expect(
			providerSessionIdForHistoryLoad({
				id: "provider-v7",
				agentId: "codex",
				source: "external",
				title: "Earlier conversation",
				agentName: "Codex",
				startedAt: "",
				lines: [],
				status: "completed",
			}),
		).toBe("provider-v7");
	});
});

describe("upsertChatSessionTurn", () => {
	it("keeps one local history item when a resumed turn gets a new runtime id", () => {
		const previous = {
			id: "runtime-first",
			agentId: "codex",
			source: "local" as const,
			title: "First question",
			agentName: "Codex",
			startedAt: "",
			lines: [],
			status: "completed" as const,
			providerSessionId: "provider-thread",
		};
		const next = {
			...previous,
			id: "runtime-second",
			title: "Second question",
			lines: [
				{ id: "u1", kind: "user" as const, text: "First question" },
				{ id: "a1", kind: "agent" as const, parts: [] },
				{ id: "u2", kind: "user" as const, text: "Second question" },
			],
		};
		const unrelated = {
			...previous,
			id: "runtime-other",
			providerSessionId: "other-thread",
		};

		expect(
			upsertChatSessionTurn([previous, unrelated], next, previous),
		).toEqual([next, unrelated]);
	});
});

describe("shouldDeferSessionEvent", () => {
	it("defers a new runtime event during a resumed turn", () => {
		expect(
			shouldDeferSessionEvent({
				sessionId: "runtime-second",
				submitting: true,
				pendingRuntimeSessionId: null,
				knownSessionIds: new Set(["runtime-first"]),
			}),
		).toBe(true);
	});

	it("does not defer events after the runtime session is known", () => {
		expect(
			shouldDeferSessionEvent({
				sessionId: "runtime-first",
				submitting: true,
				pendingRuntimeSessionId: null,
				knownSessionIds: new Set(["runtime-first"]),
			}),
		).toBe(false);
	});
});

describe("buildLocalTranscriptPrompt", () => {
	it("formats prior turns for non-resume multi-turn", () => {
		const lines: ChatLine[] = [
			{ id: "u1", kind: "user", text: "first question" },
			{
				id: "a1",
				kind: "agent",
				parts: [{ type: "text", id: "t1", text: "first answer" }],
			},
			{ id: "u2", kind: "user", text: "follow up" },
		];
		const block = buildLocalTranscriptPrompt(lines);
		expect(block).toContain("Earlier turns");
		expect(block).toContain("User: first question");
		expect(block).toContain("Assistant: first answer");
		expect(block).toContain("User: follow up");
	});

	it("includes image-only user turns with a placeholder label", () => {
		const lines: ChatLine[] = [
			{
				id: "u1",
				kind: "user",
				text: "",
				images: [{ data: "YWJj", mimeType: "image/png" }],
			},
			{
				id: "a1",
				kind: "agent",
				parts: [{ type: "text", id: "t1", text: "looks like a chart" }],
			},
		];
		const block = buildLocalTranscriptPrompt(lines);
		expect(block).toContain("User: (image attachment)");
		expect(block).toContain("Assistant: looks like a chart");
	});

	it("returns empty when there is no prior dialogue", () => {
		expect(buildLocalTranscriptPrompt([])).toBe("");
	});
});
