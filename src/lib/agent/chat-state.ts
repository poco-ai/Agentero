/**
 * Pure chat transcript / agent switcher helpers for AgentPanel.
 * Kept free of React so unit tests can cover stream merge + option building.
 */
import type { ToolUIPart } from "ai";
import type {
	AgentListResponse,
	AgentModelChoice,
	AgentPlanEntry,
	AgentPlanEvent,
	AgentResultPayload,
	AgentStreamEvent,
	AgentTemplate,
	AgentToolEvent,
	CatalogScanResponse,
	PromptImage,
} from "@/lib/agent/api";
import {
	isVisualAnnotationPromptText,
	stripPromptEnvelopeForDisplay,
} from "@/lib/agent/prompt-display";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { nextLineId, nextPartId } from "@/lib/pdf-visual/ids";

/** Snapshot of a visual PDF annotation attached to a local user chat line. */
export type ChatVisualAnnotation = {
	id: string;
	/** 1-based PDF page number. */
	page: number;
	comment: string;
	image: PromptImage;
	/** Vault-relative paper path when known. */
	paperPath?: string;
};

export type ToolUiState = {
	id: string;
	title: string;
	kind: string;
	status: "pending" | "in_progress" | "completed" | "failed";
	input?: unknown;
	output?: unknown;
};

/** A selectable answer supplied by an ACP AskUserQuestion / form elicitation. */
export type AskUserQuestionOption = {
	label: string;
	description?: string;
	/** Stable value for elicitation content (defaults to label). */
	value?: string;
};

/** A question supplied by AskUserQuestion tool or form elicitation. */
export type AskUserQuestion = {
	/** Optional field id (elicitation schema property name). */
	id?: string;
	/** Short tab/header label (Claude `header`, OpenCode `header`). */
	header?: string;
	question: string;
	/** Empty options and no allowOther → free-text only. */
	options: AskUserQuestionOption[];
	/** When false, free-text / other fields may be left blank. Default true. */
	required?: boolean;
	/**
	 * Show a free-text "Other" input on the same page as options
	 * (Codex companion field / Claude always-on / OpenCode `custom`).
	 */
	allowOther?: boolean;
	/** Elicitation content key for free-text Other (e.g. `q1__other`). */
	otherFieldId?: string;
	/**
	 * Allow selecting multiple option labels (Claude `multiSelect`,
	 * OpenCode `multiple`, Grok `multiSelect`). Answers join with ", ".
	 */
	multiSelect?: boolean;
};

/**
 * Ordered slice of an agent turn. Reasoning, tool calls, plan and message text
 * are stored in the sequence the agent emitted them so the transcript can show
 * interleaved thinking (think → tool → think → answer) instead of grouping all
 * reasoning and tools into fixed blocks.
 */
export type AgentPart =
	| { type: "reasoning"; id: string; text: string }
	| { type: "text"; id: string; text: string }
	| { type: "tool"; id: string; tool: ToolUiState }
	| { type: "plan"; id: string; entries: AgentPlanEntry[] };

export type ChatLine =
	| {
			id: string;
			kind: "user";
			/** Free-form composer text (may be empty when only visual annotations / images). */
			text: string;
			/** Local multimodal visual crops sent with this turn (session-local). */
			visualAnnotations?: ChatVisualAnnotation[];
			/**
			 * General composer image attachments (paste / file pick) for this turn.
			 * Session-local only — not persisted to ACP session history load.
			 */
			images?: PromptImage[];
	  }
	| {
			id: string;
			kind: "agent";
			parts: AgentPart[];
			sources?: string[];
			streaming?: boolean;
	  }
	| { id: string; kind: "error"; text: string }
	| { id: string; kind: "system"; text: string };

export type ChatSessionHistoryItem = {
	id: string;
	agentId: string;
	source: "local" | "indexed" | "external";
	title: string;
	agentName: string;
	startedAt: string;
	lines: ChatLine[];
	status: "running" | "completed" | "cancelled" | "failed";
	/** Durable ACP provider session id used to resume this conversation. */
	providerSessionId?: string | null;
	/**
	 * When false, never pass sessionId to runOnce (no ACP session/resume).
	 * Used for PDF visual-trace pin chats whose multi-turn context lives in
	 * local lines + prompt history, not provider sessions.
	 * Default/undefined = resume allowed when the agent supports it.
	 */
	resumeable?: boolean;
};

/** Resolve the provider-owned id required by ACP session/load and session/resume. */
export function providerSessionIdForHistoryLoad(
	item: ChatSessionHistoryItem,
): string {
	return item.providerSessionId?.trim() || item.id;
}

/**
 * Publish a newly accepted runtime turn without splitting one provider
 * conversation into multiple Agentero history rows.
 *
 * ACP creates a fresh runtime id for every request, including resumed turns.
 * The provider session id is the durable conversation identity, so remove the
 * previous active row and any stale row with the same provider id before
 * prepending the updated transcript.
 */
export function upsertChatSessionTurn(
	sessions: ChatSessionHistoryItem[],
	next: ChatSessionHistoryItem,
	previous?: ChatSessionHistoryItem,
): ChatSessionHistoryItem[] {
	const providerId = next.providerSessionId?.trim();
	return [
		next,
		...sessions.filter((item) => {
			if (item.id === next.id || item.id === previous?.id) return false;
			if (providerId && item.providerSessionId?.trim() === providerId) {
				return false;
			}
			return true;
		}),
	];
}

/** Format prior user/agent turns for agents that cannot session/resume. */
export function buildLocalTranscriptPrompt(
	lines: ChatLine[],
	/** Exclude the just-appended latest user turn (already in `prompt`). */
	opts?: { excludeTrailingUserText?: string },
): string {
	const turns: string[] = [];
	for (const line of lines) {
		if (line.kind === "user") {
			const text = line.text.trim();
			const hasVisual = Boolean(line.visualAnnotations?.length);
			const hasImages = Boolean(line.images?.length);
			if (!text && !hasVisual && !hasImages) continue;
			const label =
				text ||
				(hasVisual
					? "(visual annotation)"
					: hasImages
						? "(image attachment)"
						: "");
			turns.push(`User: ${label}`);
			continue;
		}
		if (line.kind === "agent") {
			const text = agentTextFromParts(line.parts).trim();
			if (!text) continue;
			turns.push(`Assistant: ${text}`);
		}
	}
	if (opts?.excludeTrailingUserText != null) {
		const needle = opts.excludeTrailingUserText.trim();
		if (needle) {
			const last = turns[turns.length - 1];
			if (last === `User: ${needle}`) turns.pop();
		}
	}
	if (turns.length === 0) return "";
	return ["Earlier turns in this conversation:", turns.join("\n\n")].join(
		"\n\n",
	);
}

export type PendingTerminalEvent =
	| { kind: "completed"; event: AgentResultPayload }
	| { kind: "failed"; error: string };

export type PendingSessionEvent =
	| { kind: "stream"; event: AgentStreamEvent }
	| { kind: "tool"; event: AgentToolEvent }
	| { kind: "plan"; event: AgentPlanEvent };

/**
 * Decide whether an event must wait until the accepted runtime session has
 * been published to the chat store. The provider id used for ACP resume is
 * intentionally not part of this correlation check.
 */
export function shouldDeferSessionEvent(args: {
	sessionId: string;
	submitting: boolean;
	pendingRuntimeSessionId: string | null;
	knownSessionIds: ReadonlySet<string>;
}): boolean {
	if (!args.submitting) return false;
	return (
		args.pendingRuntimeSessionId === args.sessionId ||
		(args.pendingRuntimeSessionId === null &&
			!args.knownSessionIds.has(args.sessionId))
	);
}

/** Build a chat error line (shared structure for all failure paths). */
export function errorChatLine(text: string): ChatLine {
	return { id: nextLineId("err"), kind: "error", text };
}

/** Coerce unknown thrown values into a display string. */
export { errorText } from "@/lib/core/error";

/**
 * Background workflows (paper-reader, visual pin chat, etc.) must not appear
 * in Agent chat history as separate ACP sessions. Matches titles already
 * indexed before hideFromChatHistory existed; visual prompts are filtered
 * because hideFromChatHistory is not yet enforced on the host list path.
 */
export function isBackgroundWorkflowHistoryTitle(title: string): boolean {
	const t = stripPromptEnvelopeForDisplay(title).toLowerCase();
	const raw = title.toLowerCase();
	if (isVisualAnnotationPromptText(title)) return true;
	return (
		raw.includes("paper-reader") ||
		raw.includes("paper_reader") ||
		raw.includes("agentero paper-reader") ||
		raw.includes("write structured lecture notes") ||
		raw.includes("activate and follow $paper-reader") ||
		raw.includes("activate and follow /paper-reader") ||
		raw.includes("you are running the agentero paper-reader") ||
		raw.includes("you are helping the user discuss a visual region") ||
		t.includes("activate and follow $paper-reader") ||
		t.includes("write structured lecture notes")
	);
}

/** Empty-state suggestion chips — one per row. Labels via i18n. */
export const SUGGESTION_KEYS = [
	"summarizePaper",
	"askLibrary",
	"listClaims",
	"draftRelatedWork",
] as const;

export type SuggestionKey = (typeof SUGGESTION_KEYS)[number];

/**
 * Each suggestion routes to a purpose-built backend workflow so the agent gets
 * the right system prompt (progressive disclosure, citation discipline, …)
 * instead of a generic free-form chat.
 */
export const SUGGESTION_WORKFLOW: Record<SuggestionKey, string> = {
	summarizePaper: "summary",
	askLibrary: "qa",
	listClaims: "qa",
	draftRelatedWork: "related_work",
};

export type AgentOption = {
	key: string;
	id: string | null;
	templateId: string | null;
	name: string;
	isDefault: boolean;
	source: "registry" | "catalog";
	template?: AgentTemplate;
};

function catalogTemplateFromId(templateId: string): AgentTemplate | undefined {
	switch (templateId) {
		case "opencode":
		case "openclaw":
		case "gemini":
		case "hermes":
		case "claude-acp":
		case "codex-acp":
		case "qodercli":
		case "grok-build":
		case "pi":
		case "dsh":
		case "kimi-code":
		case "custom":
			return templateId;
		default:
			return undefined;
	}
}

/** Catalog entry is usable in Chat only when ACP handshake succeeded. */
export function catalogEntryUsable(e: {
	acpStatus: string;
	binaryAvailable: boolean;
	acpCommandAvailable: boolean;
}): boolean {
	return e.acpStatus === "ready";
}

export function registryAgentUsable(a: {
	available: boolean;
	lastProbeOk?: boolean | null;
}): boolean {
	return a.available || a.lastProbeOk === true;
}

/**
 * Agents shown in the Chat header switcher.
 * Unavailable ACP backends are omitted entirely (not shown as disabled).
 */
export function buildOptions(
	registry: AgentListResponse | null,
	catalog: CatalogScanResponse | null,
): AgentOption[] {
	const options: AgentOption[] = [];
	const seenIds = new Set<string>();

	if (catalog) {
		for (const e of catalog.entries) {
			if (!catalogEntryUsable(e)) continue;
			const id = e.registeredId ?? null;
			if (id) seenIds.add(id);
			options.push({
				key: `catalog:${e.templateId}`,
				id,
				templateId: e.templateId,
				name: e.name,
				isDefault: e.isDefault,
				source: "catalog",
				template: catalogTemplateFromId(e.templateId),
			});
		}
		for (const a of catalog.customAgents) {
			if (!registryAgentUsable(a)) continue;
			if (seenIds.has(a.id)) continue;
			seenIds.add(a.id);
			options.push({
				key: `reg:${a.id}`,
				id: a.id,
				templateId: null,
				name: a.name,
				isDefault: catalog.defaultId === a.id,
				source: "registry",
				template: a.template,
			});
		}
	}

	if (registry) {
		for (const a of registry.agents) {
			if (!registryAgentUsable(a)) continue;
			if (seenIds.has(a.id)) continue;
			seenIds.add(a.id);
			options.push({
				key: `reg:${a.id}`,
				id: a.id,
				templateId: null,
				name: a.name,
				isDefault: registry.defaultId === a.id,
				source: "registry",
				template: a.template,
			});
		}
	}

	return options;
}

export function resolveSelected(
	options: AgentOption[],
	selectedId: string | null,
	registry: AgentListResponse | null,
): AgentOption | undefined {
	// options is already availability-filtered
	if (selectedId) {
		const byId = options.find((o) => o.id === selectedId);
		if (byId) return byId;
	}
	const def = options.find((o) => o.isDefault);
	if (def) return def;
	if (registry?.defaultId) {
		const byDefault = options.find((o) => o.id === registry.defaultId);
		if (byDefault) return byDefault;
	}
	return options[0];
}

export function mapToolStatus(
	status: string | null | undefined,
): ToolUiState["status"] {
	switch (status) {
		case "in_progress":
			return "in_progress";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		default:
			return "pending";
	}
}

/** True while an ask-user tool still needs a user decision (bottom surface owns the form). */
export function isPendingAskUserToolStatus(
	status: string | null | undefined,
): boolean {
	const mapped = mapToolStatus(status);
	return mapped === "pending" || mapped === "in_progress";
}

/**
 * Pending tool-shaped ask-user request promoted from transcript → composer.
 * OpenCode `question` / Claude AskUserQuestion / Codex tool variant, etc.
 */
export type ToolAskUserRequest = {
	toolCallId: string;
	sessionId: string;
	questions: AskUserQuestion[];
};

export function toolPartState(
	status: ToolUiState["status"],
): ToolUIPart["state"] {
	switch (status) {
		case "in_progress":
			return "input-available";
		case "completed":
			return "output-available";
		case "failed":
			return "output-error";
		default:
			return "input-streaming";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detect structured "ask user" tool input from multiple agent harnesses.
 *
 * Shapes (none are ACP-standard tool schemas — client adapters only):
 * - **Codex tool**: `{ variant: "AskUserQuestion", questions: [{ question, options }] }`
 * - **Claude Code**: `{ questions: [{ question, header?, multiSelect?, options }] }`
 * - **OpenCode `question`**: `{ questions: [{ question, header, options, multiple?, custom? }] }`
 * - **Grok (when mirrored as tool rawInput)**: same questions array + `multiSelect`
 *
 * Unrelated tools return null so they keep the generic JSON UI.
 * Prefer form elicitation / `x.ai/ask_user_question` when the agent uses those paths.
 */
export function parseAskUserQuestions(
	input: unknown,
): AskUserQuestion[] | null {
	let payload = input;
	if (typeof payload === "string") {
		try {
			payload = JSON.parse(payload) as unknown;
		} catch {
			return null;
		}
	}
	if (!isRecord(payload)) return null;

	const isCodexVariant = payload.variant === "AskUserQuestion";
	// Reject clearly non-question tools that happen to nest a questions key
	// under other primary parameters (heuristic: only Codex variant OR
	// top-level questions array is the dominant payload).
	if (!isCodexVariant) {
		if (payload.variant != null && payload.variant !== "AskUserQuestion") {
			return null;
		}
		// Common non-question tool keys — if present with real work payload, skip.
		if (
			payload.command != null ||
			payload.cmd != null ||
			payload.filePath != null ||
			payload.filepath != null ||
			payload.path != null ||
			payload.pattern != null ||
			payload.url != null
		) {
			return null;
		}
	}

	if (!Array.isArray(payload.questions)) return null;

	const parsed = payload.questions.flatMap((value) => {
		const one = parseOneAskUserQuestion(value, {
			// Claude always offers Other; OpenCode `custom` defaults true;
			// Codex tool path typically has fixed options only.
			defaultAllowOther: !isCodexVariant,
		});
		return one ? [one] : [];
	});
	if (parsed.length === 0) return null;

	// Claude (and some models) emit free-text as a *separate* questions[] entry
	// after a multiple-choice page. Fold those into the previous page's Other.
	const questions = foldFreeTextOnlyIntoPrevious(parsed);
	return questions.length > 0 ? questions : null;
}

/** Labels that mean "type your own" — UI already has a free-text field. */
function isSyntheticOtherOptionLabel(label: string): boolean {
	const t = label.trim();
	if (!t) return true;
	// Exact-ish: Other / 其他 / Type your own answer / …
	if (/^other(\b|[[:punct:]\s]|$)/i.test(t)) return true;
	if (/^其他(\b|[[:punct:]\s]|$)/.test(t)) return true;
	if (
		/^(type|enter|write)\s+(your\s+)?(own\s+)?(answer|response|text)/i.test(t)
	)
		return true;
	if (/^(自定义|自行输入|输入你的|自由输入)/.test(t)) return true;
	if (/^or type\b/i.test(t)) return true;
	return false;
}

/** Free-text page that is an Other companion, not a real standalone question. */
function isOtherCompanionAskPage(q: AskUserQuestion): boolean {
	if (q.options.length > 0) return false;
	const blob = `${q.header ?? ""} ${q.question}`.toLowerCase();
	if (
		/type your own answer|instead of choosing an option|choosing an option above|or type your own|enter your own|please type your own/i.test(
			blob,
		)
	) {
		return true;
	}
	if (isSyntheticOtherOptionLabel(q.question)) return true;
	if (q.header && isSyntheticOtherOptionLabel(q.header)) return true;
	return false;
}

/**
 * Merge Other free-text companion pages into the previous multi-choice page.
 * Does **not** fold legitimate free-text questions (e.g. "Anything else?").
 */
function foldFreeTextOnlyIntoPrevious(
	questions: AskUserQuestion[],
): AskUserQuestion[] {
	const out: AskUserQuestion[] = [];
	for (const q of questions) {
		const prev = out[out.length - 1];
		if (isOtherCompanionAskPage(q) && prev && prev.options.length > 0) {
			out[out.length - 1] = {
				...prev,
				allowOther: true,
				// Keep companion field id for elicitation content mapping.
				otherFieldId: prev.otherFieldId ?? q.id ?? q.otherFieldId,
			};
			continue;
		}
		out.push(q);
	}
	return out;
}

function parseOneAskUserQuestion(
	value: unknown,
	opts: { defaultAllowOther: boolean },
): AskUserQuestion | null {
	if (!isRecord(value) || typeof value.question !== "string") return null;
	const question = value.question.trim();
	if (!question) return null;

	const header =
		typeof value.header === "string"
			? value.header.trim() || undefined
			: undefined;

	const multiSelect =
		value.multiSelect === true ||
		value.multiple === true ||
		value.multi_select === true;

	// OpenCode: `custom` (default true). Explicit false disables free-text.
	// Claude: always Other. Codex tool: default false unless we see signals.
	let allowOther = opts.defaultAllowOther;
	if (typeof value.custom === "boolean") {
		allowOther = value.custom;
	} else if (value.allowOther === true || value.allow_other === true) {
		allowOther = true;
	}

	const options: AskUserQuestionOption[] = [];
	if (Array.isArray(value.options)) {
		for (const option of value.options) {
			if (!isRecord(option) || typeof option.label !== "string") continue;
			const label = option.label.trim();
			if (!label) continue;
			// Skip synthetic "Other" chips — we render free-text ourselves.
			// Still set allowOther so the free-text field appears.
			if (isSyntheticOtherOptionLabel(label)) {
				allowOther = true;
				continue;
			}
			const description =
				typeof option.description === "string"
					? option.description.trim() || undefined
					: undefined;
			const preview =
				typeof option.preview === "string"
					? option.preview.trim() || undefined
					: undefined;
			options.push({
				label,
				description: description ?? preview,
			});
		}
	}

	// Need either selectable options or free-text capability.
	if (options.length === 0 && !allowOther) return null;

	const id =
		typeof value.id === "string" && value.id.trim()
			? value.id.trim()
			: undefined;

	return {
		...(id ? { id } : {}),
		...(header ? { header } : {}),
		question,
		options,
		allowOther: options.length === 0 ? true : allowOther,
		...(multiSelect ? { multiSelect: true } : {}),
	};
}

/** Format selected options as a concise, self-contained follow-up turn. */
export function formatAskUserAnswers(
	questions: AskUserQuestion[],
	answers: string[],
): string {
	return questions
		.map(
			(question, index) =>
				`Question: ${question.question}\nAnswer: ${answers[index]}`,
		)
		.join("\n\n");
}

type ElicitationFieldInput = {
	id: string;
	title: string;
	description?: string | null;
	required?: boolean;
	kind: string;
	options: Array<{
		value: string;
		title: string;
		description?: string | null;
	}>;
	isOtherAnswer?: boolean;
	parentFieldId?: string | null;
};

/** Codex companion free-text field: `questionId__other` or `questionId__other2`. */
function parseOtherFieldParentId(fieldId: string): string | null {
	const match = fieldId.match(/^(.*)__other\d*$/i);
	return match?.[1] ?? null;
}

function isTextishElicitationField(field: ElicitationFieldInput): boolean {
	if (field.kind === "text") return true;
	if (field.kind === "select" || field.kind === "boolean") return false;
	return field.options.length === 0;
}

/**
 * Codex / Claude free-text "Other" companion (often lacks __other id or meta).
 * Example description: "Type your own answer instead of choosing an option above (optional)."
 */
function isOtherCompanionElicitationField(
	field: ElicitationFieldInput,
): boolean {
	if (field.isOtherAnswer) return true;
	if (!isTextishElicitationField(field)) return false;
	if (parseOtherFieldParentId(field.id)) return true;
	const blob = `${field.title ?? ""} ${field.description ?? ""}`.toLowerCase();
	if (
		/type your own answer|instead of choosing an option|choosing an option above|or type your own|enter your own/i.test(
			blob,
		)
	) {
		return true;
	}
	if (/^(other|其他)(\b|[[:punct:]\s]|$)/i.test(field.title.trim())) {
		return true;
	}
	if (/可选|optional/.test(blob) && /own answer|自定义|自行/.test(blob)) {
		return true;
	}
	return false;
}

function mapFieldOptions(
	field: ElicitationFieldInput,
): AskUserQuestionOption[] {
	if (field.kind !== "select" && field.kind !== "boolean") return [];
	const options: AskUserQuestionOption[] = [];
	for (const option of field.options) {
		const label = (option.title || option.value).trim();
		if (!label) continue;
		// Skip synthetic Other chips — free-text field is separate.
		if (isSyntheticOtherOptionLabel(label)) continue;
		options.push({
			label,
			description: option.description?.trim() || undefined,
			value: option.value,
		});
	}
	return options;
}

/**
 * Map Grok Host `agent:ask-user-request` DTOs into AskUserQuestion pages.
 */
export function questionsFromAskUserDtos(
	items: Array<{
		question: string;
		options: Array<{ label: string; description?: string | null }>;
		multiSelect?: boolean;
		allowOther?: boolean;
	}>,
): AskUserQuestion[] {
	return items.flatMap((item) => {
		const question = item.question.trim();
		if (!question) return [];
		const options = item.options.flatMap((option) => {
			const label = option.label.trim();
			if (!label) return [];
			const description =
				typeof option.description === "string"
					? option.description.trim() || undefined
					: undefined;
			return [{ label, description }];
		});
		const allowOther = item.allowOther !== false;
		if (options.length === 0 && !allowOther) return [];
		return [
			{
				question,
				options,
				allowOther: options.length === 0 ? true : allowOther,
				...(item.multiSelect ? { multiSelect: true } : {}),
			},
		];
	});
}

/**
 * Map ACP form elicitation fields into AskUserQuestion pages.
 * Codex / Claude split each Q into select + optional free-text Other — merge into one page.
 *
 * Parent linkage (any one is enough):
 * 1. meta `isOtherAnswer` + `parentFieldId` / `questionId`
 * 2. field id `questionId__other`
 * 3. content heuristic ("Type your own answer instead of…") → attach to previous select
 * 4. leftover free-text-only pages folded into previous select page
 */
export function questionsFromElicitationFields(
	fields: ElicitationFieldInput[],
): AskUserQuestion[] {
	const otherByParent = new Map<string, ElicitationFieldInput>();
	const consumedOtherIds = new Set<string>();

	// Pass 1: explicit parent (meta or __other id).
	for (const field of fields) {
		if (!isTextishElicitationField(field) && !field.isOtherAnswer) continue;
		const parentFromMeta =
			field.isOtherAnswer && field.parentFieldId?.trim()
				? field.parentFieldId.trim()
				: field.parentFieldId?.trim() || null;
		const parentFromId = parseOtherFieldParentId(field.id);
		const parentId = parentFromMeta || parentFromId;
		if (!parentId) continue;
		// Prefer first companion per parent; ignore extras.
		if (otherByParent.has(parentId)) continue;
		otherByParent.set(parentId, field);
		consumedOtherIds.add(field.id);
	}

	// Pass 2: content-based Other without meta — pair with nearest preceding select.
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field || consumedOtherIds.has(field.id)) continue;
		if (!isOtherCompanionElicitationField(field)) continue;
		let parent: ElicitationFieldInput | undefined;
		for (let j = i - 1; j >= 0; j--) {
			const cand = fields[j];
			if (!cand || consumedOtherIds.has(cand.id)) continue;
			if (mapFieldOptions(cand).length > 0) {
				parent = cand;
				break;
			}
		}
		if (!parent) continue;
		if (otherByParent.has(parent.id)) continue;
		otherByParent.set(parent.id, field);
		consumedOtherIds.add(field.id);
	}

	const out: AskUserQuestion[] = [];
	for (const field of fields) {
		if (consumedOtherIds.has(field.id)) continue;
		const options = mapFieldOptions(field);
		const other = otherByParent.get(field.id);
		// Prefer title for select labels; description is often the long question.
		// For free-text companions wrongly left as mains, description is boilerplate — skip later fold.
		const question = (field.description || field.title).trim();
		if (!question && options.length === 0 && !other) continue;

		const freeTextOnly = options.length === 0 && !other;
		// Don't use Other boilerplate as a standalone page title if we can fold later.
		const displayQuestion =
			freeTextOnly && isOtherCompanionElicitationField(field)
				? (field.title || question).trim()
				: question || field.title.trim();
		if (!displayQuestion && options.length === 0) continue;

		out.push({
			id: field.id,
			question: displayQuestion || field.id,
			options,
			required: field.required !== false && !freeTextOnly,
			allowOther: Boolean(other) || freeTextOnly,
			otherFieldId: other?.id ?? (freeTextOnly ? field.id : undefined),
		});
	}

	// Pass 3: any free-text-only page still after a select page → merge as Other.
	return foldFreeTextOnlyIntoPrevious(out);
}

/**
 * Build elicitation content map.
 * Option pick → primary field id; free-text Other → otherFieldId (Codex preference).
 */
export function elicitationContentFromAnswers(
	questions: AskUserQuestion[],
	answers: string[],
): Record<string, string> {
	const content: Record<string, string> = {};
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const answer = answers[i]?.trim();
		if (!q || !answer) continue;
		const matched = q.options.find((option) => option.label === answer);
		if (matched && q.id) {
			content[q.id] = matched.value ?? matched.label;
			continue;
		}
		// Free-text / Other (not matching an option label).
		if (q.otherFieldId) {
			content[q.otherFieldId] = answer;
		} else if (q.id) {
			content[q.id] = answer;
		}
	}
	return content;
}

export type ToolPatch = {
	id: string;
	title?: string | null;
	kind?: string | null;
	status?: string | null;
	input?: unknown;
	output?: unknown;
	full?: boolean;
};

export function mergeToolState(
	prev: ToolUiState | undefined,
	patch: ToolPatch,
): ToolUiState {
	return {
		id: patch.id,
		title: patch.title ?? prev?.title ?? "",
		kind: patch.kind ?? prev?.kind ?? "other",
		status: mapToolStatus(patch.status ?? prev?.status),
		input: patch.input !== undefined ? patch.input : prev?.input,
		output: patch.output !== undefined ? patch.output : prev?.output,
	};
}

/**
 * Append a streamed message/thought chunk, extending the trailing part when it
 * matches so consecutive chunks of the same kind stay in one block but a switch
 * of kind (thought → message or vice versa) starts a fresh, ordered part.
 */
export function appendStreamPart(
	parts: AgentPart[],
	kind: "reasoning" | "text",
	chunk: string,
): AgentPart[] {
	const last = parts[parts.length - 1];
	if (last && last.type === kind) {
		const next = parts.slice();
		next[next.length - 1] = { ...last, text: last.text + chunk };
		return next;
	}
	return [...parts, { type: kind, id: nextPartId(kind), text: chunk }];
}

/**
 * Upsert a tool call by id: update the existing part in place (keeping its
 * position in the timeline) or append a new tool part at the current tail.
 */
export function applyToolToParts(
	parts: AgentPart[],
	patch: ToolPatch,
): AgentPart[] {
	const idx = parts.findIndex(
		(p) => p.type === "tool" && p.tool.id === patch.id,
	);
	if (idx >= 0) {
		const existing = parts[idx] as Extract<AgentPart, { type: "tool" }>;
		const next = parts.slice();
		next[idx] = { ...existing, tool: mergeToolState(existing.tool, patch) };
		return next;
	}
	return [
		...parts,
		{
			type: "tool",
			id: nextPartId("tool"),
			tool: mergeToolState(undefined, patch),
		},
	];
}

/** Apply a tool update to its existing turn, including updates arriving after turn completion. */
export function applyToolToLines(
	lines: ChatLine[],
	patch: ToolPatch,
): ChatLine[] {
	let streamingIndex = -1;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line?.kind !== "agent") continue;
		if (
			line.parts.some(
				(part) => part.type === "tool" && part.tool.id === patch.id,
			)
		) {
			// Late payloads still apply, but progress cannot reopen a finished turn.
			const update =
				!line.streaming &&
				patch.status !== "completed" &&
				patch.status !== "failed"
					? { ...patch, status: undefined }
					: patch;
			const next = lines.slice();
			next[index] = { ...line, parts: applyToolToParts(line.parts, update) };
			return next;
		}
		if (streamingIndex < 0 && line.streaming) streamingIndex = index;
	}

	if (streamingIndex < 0) return lines;
	const line = lines[streamingIndex];
	if (line?.kind !== "agent") return lines;
	const next = lines.slice();
	next[streamingIndex] = {
		...line,
		parts: applyToolToParts(line.parts, patch),
	};
	return next;
}

/** A finished turn must not retain an infinite spinner for an unfinished tool call. */
export function failIncompleteTools(parts: AgentPart[]): AgentPart[] {
	let changed = false;
	const next = parts.map((part) => {
		if (
			part.type !== "tool" ||
			(part.tool.status !== "pending" && part.tool.status !== "in_progress")
		) {
			return part;
		}
		changed = true;
		return { ...part, tool: { ...part.tool, status: "failed" as const } };
	});
	return changed ? next : parts;
}

/** Plan updates arrive as full snapshots; keep a single plan part in place. */
export function upsertPlanPart(
	parts: AgentPart[],
	entries: AgentPlanEntry[],
): AgentPart[] {
	const idx = parts.findIndex((p) => p.type === "plan");
	if (idx >= 0) {
		const existing = parts[idx] as Extract<AgentPart, { type: "plan" }>;
		const next = parts.slice();
		next[idx] = { ...existing, entries };
		return next;
	}
	return [...parts, { type: "plan", id: nextPartId("plan"), entries }];
}

export function agentTextFromParts(parts: AgentPart[]): string {
	return parts
		.filter((p): p is Extract<AgentPart, { type: "text" }> => p.type === "text")
		.map((p) => p.text)
		.join("");
}

export function agentReasoningFromParts(parts: AgentPart[]): string {
	return parts
		.filter(
			(p): p is Extract<AgentPart, { type: "reasoning" }> =>
				p.type === "reasoning",
		)
		.map((p) => p.text)
		.join("\n\n");
}

/** True when the turn has produced anything worth keeping on screen. */
export function agentHasContent(parts: AgentPart[]): boolean {
	return parts.some((p) => {
		if (p.type === "text" || p.type === "reasoning") {
			return p.text.trim().length > 0;
		}
		if (p.type === "plan") return p.entries.length > 0;
		return true;
	});
}

export async function copyText(text: string) {
	await copyTextToClipboard(text);
}

/** Client-side dedupe (id first, then display name) for cached/stale catalogs. */
export function dedupeModelsClient(
	models: AgentModelChoice[],
): AgentModelChoice[] {
	const seenIds = new Set<string>();
	const seenNames = new Set<string>();
	const out: AgentModelChoice[] = [];
	for (const m of models) {
		const id = m.id.trim();
		const nameKey = m.name.trim().toLowerCase();
		if (!id || !nameKey) continue;
		if (seenIds.has(id) || seenNames.has(nameKey)) continue;
		seenIds.add(id);
		seenNames.add(nameKey);
		out.push({
			id,
			name: m.name.trim(),
			group: m.group,
		});
	}
	return out;
}

/**
 * Ensure free-form / third-party model ids appear in the catalog even when the
 * ACP agent only advertises a fixed official list (e.g. Codex + gateway).
 * Extra ids are prepended with optional custom group label.
 */
export function ensureModelsInclude(
	models: AgentModelChoice[],
	extraIds: Array<string | null | undefined>,
	customGroup?: string | null,
): AgentModelChoice[] {
	const extras: AgentModelChoice[] = [];
	const seen = new Set(
		models.map((m) => m.id.trim()).filter((id) => id.length > 0),
	);
	for (const raw of extraIds) {
		const id = typeof raw === "string" ? raw.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		extras.push({
			id,
			name: id,
			group: customGroup ?? null,
		});
	}
	return dedupeModelsClient([...extras, ...models]);
}
