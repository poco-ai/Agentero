import { normalizeQuoteContext } from "./selection-context";
/**
 * Inline @mention / $skill / /command / selection tokens embedded in composer
 * draft text. Contenteditable renders markers as chips; send path strips
 * mention/skill/selection markers and expands command markers to the command's
 * advertised prefix (usually `/name`, `$name` for ACP skills). The raw draft is
 * kept on the user line so the transcript can redraw @ / $ / / chips after send.
 */

import { plazaMentionTitle } from "@/lib/agent/plaza-mention";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { basenameOf } from "@/lib/core/path";

const MENTION_RE = /\{\{m:([^}]+)\}\}/g;
const SKILL_RE = /\{\{s:([^}]+)\}\}/g;
const COMMAND_RE = /\{\{c:([^}]+)\}\}/g;
const SELECTION_RE = /\{\{sel:([^}]+)\}\}/g;
const VISUAL_RE = /\{\{vis:([^}]+)\}\}/g;
const ANY_TOKEN_RE = /\{\{(?:m|s|c|sel|vis):[^}]+\}\}/g;
const TOKEN_SPAN_RE = /\{\{(?:m|s|c|sel|vis):[^}]+\}\}/g;

export function encodeMentionToken(path: string): string {
	return `{{m:${encodeURIComponent(path)}}}`;
}

export function encodeSkillToken(skillId: string): string {
	return `{{s:${encodeURIComponent(skillId)}}}`;
}

export function encodeCommandToken(commandName: string): string {
	return `{{c:${encodeURIComponent(commandName)}}}`;
}

function decodePayload(payload: string): string {
	try {
		return decodeURIComponent(payload);
	} catch {
		return payload;
	}
}

export function decodeMentionTokenPayload(payload: string): string {
	return decodePayload(payload);
}

export function decodeSkillTokenPayload(payload: string): string {
	return decodePayload(payload);
}

export function decodeCommandTokenPayload(payload: string): string {
	return decodePayload(payload);
}

function base64UrlEncode(input: string): string {
	const bytes = new TextEncoder().encode(input);
	const binString = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
	return btoa(binString)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
	const padded =
		input.replace(/-/g, "+").replace(/_/g, "/") +
		"===".slice((input.length + 3) % 4);
	try {
		const binString = atob(padded);
		const bytes = Uint8Array.from(binString, (c) => c.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return "";
	}
}

export function encodeSelectionToken(selection: SelectionContext): string {
	const json = JSON.stringify(selection);
	return `{{sel:${base64UrlEncode(json)}}}`;
}

/** Inline visual-annotation marker. The crop stays in the visual draft store. */
export function encodeVisualToken(id: string): string {
	return `{{vis:${encodeURIComponent(id)}}}`;
}

export function decodeVisualTokenPayload(payload: string): string {
	return decodePayload(payload);
}

export function decodeSelectionTokenPayload(
	payload: string,
): SelectionContext | null {
	const json = base64UrlDecode(payload);
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return null;
		const candidate = parsed as Partial<SelectionContext>;
		if (
			typeof candidate.id !== "string" ||
			typeof candidate.text !== "string" ||
			typeof candidate.sourcePath !== "string" ||
			(candidate.origin !== "pdf" &&
				candidate.origin !== "markdown" &&
				candidate.origin !== "chat")
		) {
			return null;
		}
		return {
			id: candidate.id,
			text: candidate.text,
			sourcePath: candidate.sourcePath,
			sourceTitle:
				typeof candidate.sourceTitle === "string"
					? candidate.sourceTitle
					: undefined,
			sourceUrl:
				typeof candidate.sourceUrl === "string"
					? candidate.sourceUrl
					: undefined,
			surface: candidate.surface,
			origin: candidate.origin,
			page: candidate.page,
			lineFrom: candidate.lineFrom,
			lineTo: candidate.lineTo,
			comment:
				typeof candidate.comment === "string" ? candidate.comment : undefined,
			messageId:
				typeof candidate.messageId === "string"
					? candidate.messageId
					: undefined,
			chatSessionId:
				typeof candidate.chatSessionId === "string"
					? candidate.chatSessionId
					: undefined,
			context: candidate.context
				? normalizeQuoteContext(candidate.context)
				: undefined,
			textAnchor:
				candidate.textAnchor &&
				typeof candidate.textAnchor.exact === "string" &&
				typeof candidate.textAnchor.prefix === "string" &&
				typeof candidate.textAnchor.suffix === "string"
					? {
							exact: candidate.textAnchor.exact,
							prefix: candidate.textAnchor.prefix,
							suffix: candidate.textAnchor.suffix,
						}
					: undefined,
			rects: candidate.rects,
			paperAbsPath: candidate.paperAbsPath,
			pinned: candidate.pinned === true,
		};
	} catch {
		return null;
	}
}

/** Paths in document order (duplicates kept once, first wins). */
export function extractMentionPaths(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const match of text.matchAll(MENTION_RE)) {
		const path = decodeMentionTokenPayload(match[1] ?? "").trim();
		if (!path || seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

/** Skill ids in document order (duplicates kept once, first wins). */
export function extractSkillIds(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const match of text.matchAll(SKILL_RE)) {
		const id = decodeSkillTokenPayload(match[1] ?? "").trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/** Selection contexts in document order. */
export function extractSelectionTokens(text: string): SelectionContext[] {
	const out: SelectionContext[] = [];
	for (const match of text.matchAll(SELECTION_RE)) {
		const sel = decodeSelectionTokenPayload(match[1] ?? "");
		if (sel) out.push(sel);
	}
	return out;
}

/** Visual draft ids in document order (duplicates kept once, first wins). */
export function extractVisualIds(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const match of text.matchAll(VISUAL_RE)) {
		const id = decodeVisualTokenPayload(match[1] ?? "").trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/** Drop one visual marker and the extra space it leaves between words. */
export function removeVisualToken(text: string, id: string): string {
	const token = encodeVisualToken(id);
	if (!text.includes(token)) return text;
	return text.replaceAll(token, "").replace(/[ \t]{2,}/g, " ");
}

/** Hide only valid selection tokens in the editor; keep them in the owning chat draft. */
export function withoutSelectionTokens(text: string): string {
	return text.replace(SELECTION_RE, (token, payload: string) =>
		decodeSelectionTokenPayload(payload) ? "" : token,
	);
}

/**
 * Insert inline markers at a serialized caret.
 * `offset === null` appends. A trailing newline stays after the marker when
 * the caret is in front of it, so the reference shares the current line.
 * The returned caret sits just after the inserted markers.
 */
export function insertTokensAt(
	draft: string,
	offset: number | null,
	tokens: string,
): { text: string; caret: number } {
	if (!tokens) {
		const caret = offset == null ? draft.length : clampOffset(draft, offset);
		return { text: draft, caret };
	}
	let at = offset == null ? draft.length : clampOffset(draft, offset);
	for (const match of draft.matchAll(TOKEN_SPAN_RE)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (at > start && at < end) {
			at = end;
			break;
		}
	}
	const before = draft.slice(0, at);
	const after = draft.slice(at);
	const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
	const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
	const text = `${before}${lead}${tokens}${trail}${after}`;
	return {
		text,
		caret: before.length + lead.length + tokens.length + trail.length,
	};
}

function clampOffset(draft: string, offset: number): number {
	if (!Number.isFinite(offset)) return draft.length;
	return Math.max(0, Math.min(draft.length, offset));
}

/**
 * Where a newly pinned reference should land.
 * A recorded caret is used as-is, including a caret the user moved onto the
 * next line. An unknown caret (the field never reported a selection) would
 * otherwise append after the contenteditable's placeholder break and paint
 * the reference on its own line.
 */
export function referenceInsertionOffset(
	draft: string,
	offset: number | null,
): number | null {
	if (offset != null) return offset;
	if (draft.endsWith("\n") && !draft.endsWith("\n\n")) return draft.length - 1;
	return null;
}

/**
 * Append newly pinned quotes after the prose the user is writing.
 * Quotes already present (same id) are left where they are.
 */
export function appendSelectionTokens(
	draft: string,
	selections: SelectionContext[],
): string {
	const existing = new Set(extractSelectionTokens(draft).map((s) => s.id));
	const tokens = selections
		.filter((selection) => !existing.has(selection.id))
		.map(encodeSelectionToken)
		.join("");
	if (!tokens) return draft;
	return insertTokensAt(draft, null, tokens).text;
}

/** Keep annotations in insertion order and before prose so @/$ completion sees the typed suffix. */
export function mergeSelectionDraftInput(draft: string, input: string): string {
	const selections = new Map(
		extractSelectionTokens(draft).map((s) => [s.id, s]),
	);
	for (const selection of extractSelectionTokens(input))
		selections.set(selection.id, selection);
	return (
		Array.from(selections.values(), encodeSelectionToken).join("") +
		withoutSelectionTokens(input)
	);
}
export function updateSelectionToken(
	text: string,
	id: string,
	comment: string | null,
): string {
	return text.replace(SELECTION_RE, (token, payload: string) => {
		const selection = decodeSelectionTokenPayload(payload);
		if (!selection || selection.id !== id) return token;
		return comment === null
			? ""
			: encodeSelectionToken({
					...selection,
					comment: comment.trim() || undefined,
				});
	});
}

/** Rewrite one selection marker in place. An absent id leaves the text unchanged. */
export function replaceSelectionToken(
	text: string,
	selection: SelectionContext,
): string {
	const encoded = encodeSelectionToken(selection);
	let changed = false;
	const next = text.replace(SELECTION_RE, (token, payload: string) => {
		const current = decodeSelectionTokenPayload(payload);
		if (!current || current.id !== selection.id || token === encoded) {
			return token;
		}
		changed = true;
		return encoded;
	});
	return changed ? next : text;
}

/**
 * Draft → send/display body:
 * - mention / skill / selection markers removed (paths, skillIds, selections travel separately)
 * - command markers become the advertised invocation (`/name` or `$name`)
 */
export function stripInlineTokens(text: string): string {
	return text
		.replace(COMMAND_RE, (_m, payload: string) =>
			commandInvocationLabel(decodeCommandTokenPayload(payload)),
		)
		.replace(/\{\{(?:m|s|sel|vis):[^}]+\}\}/g, "")
		.replace(/\u200B/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/** @ / $ / / chips that should survive in the sent bubble and the queue. */
const TRANSCRIPT_CHIP_RE = /\{\{(?:m|s|c):[^}]+\}\}/;

export function hasTranscriptChips(text: string): boolean {
	return TRANSCRIPT_CHIP_RE.test(text);
}

/**
 * Composer draft to store on the user line. Undefined when the draft has no
 * mention / skill / command chip, so plain turns stay a single string.
 */
export function transcriptMarkup(textRaw: string): string | undefined {
	return hasTranscriptChips(textRaw) ? textRaw : undefined;
}

/** Strip trigger / "skill :" chrome — chip shows the bare skill name. */
export function displaySkillName(name: string): string {
	return name
		.trim()
		.replace(/^[/$]+/, "")
		.replace(/^skill\s*:\s*/i, "");
}

/** Prefix a command token should keep when it is sent to the agent. */
export function commandPrefix(invocation: string): "/" | "$" {
	return invocation.trim().startsWith("$") ? "$" : "/";
}

/** Readable invocation for a command token (`$skill`, `/help`). */
export function commandInvocationLabel(invocation: string): string {
	const name = displaySkillName(invocation);
	return name ? `${commandPrefix(invocation)}${name}` : "";
}

/** Visible label for an @ chip: plaza title, otherwise the path basename. */
export function mentionChipLabel(path: string): string {
	return plazaMentionTitle(path) || basenameOf(path) || path;
}

function chipTokenSource(part: InlineTokenPart): string {
	switch (part.type) {
		case "mention":
			return encodeMentionToken(part.path);
		case "skill":
			return encodeSkillToken(part.skillId);
		case "command":
			return encodeCommandToken(part.name);
		case "selection":
			return encodeSelectionToken(part.selection);
		case "visual":
			return encodeVisualToken(part.id);
		default:
			return "";
	}
}

function chipPlainLabel(part: InlineTokenPart): string {
	if (part.type === "mention") return `@${mentionChipLabel(part.path)}`;
	if (part.type === "skill") return displaySkillName(part.skillId);
	if (part.type === "command") {
		return commandInvocationLabel(part.name);
	}
	return "";
}

/**
 * Draft → copy / history / replay text. Mention, skill, and command chips
 * become readable labels; selection and visual markers stay out (they travel
 * on their own fields).
 */
export function inlineMarkupToPlain(markup: string): string {
	return parseInlineTokenParts(markup)
		.map((part) => (part.type === "text" ? part.value : chipPlainLabel(part)))
		.join("")
		.replace(/\u200B/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/**
 * Edit-and-resend. An unchanged sentence keeps chip positions. A changed
 * sentence keeps the same chips, appended after the new prose.
 */
export function retainTranscriptChips(
	prose: string,
	markup: string | undefined,
): string {
	if (!markup || !hasTranscriptChips(markup)) return prose;
	if (stripInlineTokens(markup).trim() === prose.trim()) return markup;
	const tokens = parseInlineTokenParts(markup)
		.map(chipTokenSource)
		.filter(Boolean)
		.join("");
	if (!tokens) return prose;
	const needsSpace = prose.length > 0 && !/\s$/.test(prose);
	return `${prose}${needsSpace ? " " : ""}${tokens}`;
}

/**
 * Text used for @ / $ / / trigger detection at the caret end.
 * Markers count as a single "atom" so `$` inside `{{s:…}}` does not open the menu.
 */
export function plainTriggerSuffix(text: string): string {
	return text.replace(ANY_TOKEN_RE, "\uFFFC");
}

/**
 * Start, whitespace, or an inline token. A selection/mention chip sitting
 * against `@` / `$` / `/` is still a trigger boundary.
 */
const TRIGGER_BOUNDARY = String.raw`(?:^|\s|\{\{(?:m|s|c|sel|vis):[^}]+\}\})`;

/** Replace a trailing `@` / `$` / `/` trigger with an inline token + space. */
export function replaceTrailingTriggerWithToken(
	text: string,
	kind: "mention" | "skill" | "command",
	token: string,
): string {
	const trigger = kind === "mention" ? "@" : "[/$]";
	const pattern = new RegExp(`(${TRIGGER_BOUNDARY})${trigger}[^\\s]*$`);
	if (!pattern.test(text)) {
		const needsSpace = text.length > 0 && !/\s$/.test(text);
		return `${text}${needsSpace ? " " : ""}${token} `;
	}
	return text.replace(pattern, (_m, prefix: string) => `${prefix}${token} `);
}

/** Append tokens for paths/skills that are in state but missing from text (legacy drafts). */
export function appendMissingInlineTokens(
	text: string,
	mentionedPaths: string[],
	selectedSkillIds: string[],
): string {
	const havePaths = new Set(extractMentionPaths(text));
	const haveSkills = new Set(extractSkillIds(text));
	let next = text;
	for (const path of mentionedPaths) {
		if (!path || havePaths.has(path)) continue;
		const needsSpace = next.length > 0 && !/\s$/.test(next);
		next = `${next}${needsSpace ? " " : ""}${encodeMentionToken(path)}`;
		havePaths.add(path);
	}
	for (const id of selectedSkillIds) {
		if (!id || haveSkills.has(id)) continue;
		const needsSpace = next.length > 0 && !/\s$/.test(next);
		next = `${next}${needsSpace ? " " : ""}${encodeSkillToken(id)}`;
		haveSkills.add(id);
	}
	if (next !== text && !/\s$/.test(next)) next = `${next} `;
	return next;
}

export type InlineTokenPart =
	| { type: "text"; value: string }
	| { type: "mention"; path: string }
	| { type: "skill"; skillId: string }
	| { type: "command"; name: string }
	| { type: "selection"; selection: SelectionContext }
	| { type: "visual"; id: string };

/** Split draft text into renderable parts (text + chips). */
export function parseInlineTokenParts(text: string): InlineTokenPart[] {
	const parts: InlineTokenPart[] = [];
	const re = /\{\{(m|s|c|sel|vis):([^}]+)\}\}/g;
	let last = 0;
	for (const match of text.matchAll(re)) {
		const index = match.index ?? 0;
		if (index > last) {
			parts.push({ type: "text", value: text.slice(last, index) });
		}
		const kind = match[1];
		const payload = match[2] ?? "";
		if (kind === "m") {
			parts.push({
				type: "mention",
				path: decodeMentionTokenPayload(payload),
			});
		} else if (kind === "s") {
			parts.push({
				type: "skill",
				skillId: decodeSkillTokenPayload(payload),
			});
		} else if (kind === "c") {
			parts.push({
				type: "command",
				name: decodeCommandTokenPayload(payload),
			});
		} else if (kind === "sel") {
			const selection = decodeSelectionTokenPayload(payload);
			if (selection) {
				parts.push({ type: "selection", selection });
			}
		} else if (kind === "vis") {
			const id = decodeVisualTokenPayload(payload).trim();
			if (id) parts.push({ type: "visual", id });
		}
		last = index + match[0].length;
	}
	if (last < text.length) {
		parts.push({ type: "text", value: text.slice(last) });
	}
	return parts;
}
