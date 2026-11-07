import {
	createStreamingParser,
	type ElementNode,
	isElementNode,
	type ParseResult,
	type StreamParser,
	type ValidationError,
} from "@openuidev/lang-core";
import {
	isOpenUiLanguage,
	OPENUI_LIMITS,
	OPENUI_MAX_SOURCE_CHARS,
	OPENUI_ROOT_COMPONENT,
} from "./config";
import { OPENUI_SCHEMA } from "./schema";

export type OpenUiFailureReason =
	| "empty"
	| "invalid"
	| "tooLarge"
	| "incomplete";

export type OpenUiBlockView =
	| { kind: "ready"; root: ElementNode; source: string }
	| { kind: "streaming"; root: ElementNode | null; source: string }
	| { kind: "failed"; reason: OpenUiFailureReason; source: string };

export type ResolveOpenUiBlockResult = {
	view: OpenUiBlockView;
	lastValid: ElementNode | null;
};

export type OpenUiRenderFailure = "invalid" | "tooLarge";

/**
 * Create a streaming parser bound to the read-only component catalog. Callers
 * keep one instance per rendered block and feed cumulative source text.
 */
export function createOpenUiParser(): StreamParser {
	return createStreamingParser(OPENUI_SCHEMA, OPENUI_ROOT_COMPONENT);
}

export function fatalOpenUiErrors(result: ParseResult): ValidationError[] {
	return result.meta.errors.filter((error) => error.severity !== "warning");
}

/**
 * Normalize the `<openui-lang>…</openui-lang>` compatibility form into a
 * fenced block. Only line-start tags outside Markdown fences are rewritten; an
 * unclosed tag becomes an unclosed fence so Streamdown can report streaming.
 */
export function normalizeOpenUiTags(markdown: string): string {
	if (!/<openui-lang/i.test(markdown)) return markdown;

	const lines = markdown.split("\n");
	const out: string[] = [];
	let fence: { char: string; length: number } | null = null;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (fence) {
			out.push(line);
			if (isClosingFence(line, fence)) fence = null;
			continue;
		}

		const openingFence = parseOpeningFence(line);
		if (openingFence) {
			fence = { char: openingFence.char, length: openingFence.length };
			out.push(line);
			continue;
		}

		const singleLine =
			/^[ \t]*<openui-lang>([\s\S]*?)<\/openui-lang>[ \t]*$/i.exec(line);
		if (singleLine) {
			out.push("```openui-lang");
			const body = singleLine[1] ?? "";
			if (body.trim()) out.push(body);
			out.push("```");
			continue;
		}

		const openTag = /^[ \t]*<openui-lang>(.*)$/i.exec(line);
		if (openTag) {
			out.push("```openui-lang");
			const firstLine = openTag[1] ?? "";
			if (firstLine.trim()) out.push(firstLine);
			let closed = false;
			for (index += 1; index < lines.length; index += 1) {
				const next = lines[index] ?? "";
				if (/^[ \t]*<\/openui-lang>[ \t]*$/i.test(next)) {
					closed = true;
					break;
				}
				out.push(next);
			}
			if (closed) out.push("```");
			continue;
		}

		out.push(line);
	}

	return out.join("\n");
}

/**
 * Temporarily mask OpenUI fences before {@link prepareAgentMessageMarkdown}.
 * The chat preprocessors (math normalization, bare-link / wikilink rewrites)
 * must not alter model-authored block source: the same text is what the copy
 * action and the failure fallback show to the reader.
 */
export function protectOpenUiBlocks(markdown: string): {
	text: string;
	restore: (text: string) => string;
} {
	const blocks: string[] = [];
	const lines = markdown.split("\n");
	const out: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const opening = parseOpeningFence(line);
		if (!opening) {
			out.push(line);
			continue;
		}

		const blockLines = [line];
		if (isOpenUiLanguage(opening.language)) {
			for (index += 1; index < lines.length; index += 1) {
				const next = lines[index] ?? "";
				blockLines.push(next);
				if (isClosingFence(next, opening)) break;
			}
			const token = openUiToken(blocks.length);
			blocks.push(blockLines.join("\n"));
			out.push(token);
			continue;
		}

		// Consume non-OpenUI fences whole so a nested openui fence is not
		// mistaken for a top-level block.
		for (index += 1; index < lines.length; index += 1) {
			const next = lines[index] ?? "";
			blockLines.push(next);
			if (isClosingFence(next, opening)) break;
		}
		out.push(...blockLines);
	}

	const text = out.join("\n");
	return {
		text,
		restore(value: string) {
			let restored = value;
			for (let index = 0; index < blocks.length; index += 1) {
				restored = restored.replace(openUiToken(index), blocks[index] ?? "");
			}
			return restored;
		},
	};
}

function openUiToken(index: number): string {
	return `\u0000AGENTERO_OPENUI_${index}\u0000`;
}

function parseOpeningFence(
	line: string,
): { char: string; length: number; language: string } | null {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	const marker = match?.[1];
	if (!marker) return null;
	const language = (match[2] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	return { char: marker[0] ?? "`", length: marker.length, language };
}

function isClosingFence(
	line: string,
	fence: { char: string; length: number },
): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	const marker = match?.[1];
	return (
		marker != null && marker[0] === fence.char && marker.length >= fence.length
	);
}

/**
 * Keep props from the last structurally valid parse for nodes that are still
 * being streamed. Children that are already complete are kept from the new
 * tree, so a growing Stack still reveals new blocks while truncated strings do
 * not flash partial values.
 */
export function mergePartialTree(
	current: ElementNode | null,
	previous: ElementNode | null,
): ElementNode | null {
	if (!current) return previous;
	if (!previous || previous.typeName !== current.typeName) return current;

	const props: Record<string, unknown> = { ...current.props };
	for (const [key, value] of Object.entries(current.props)) {
		const previousValue = previous.props[key];
		if (Array.isArray(value)) {
			props[key] = mergePartialArray(value, previousValue, current.partial);
			continue;
		}
		if (isElementNode(value)) {
			props[key] = mergePartialTree(
				value,
				isElementNode(previousValue) ? previousValue : null,
			);
			continue;
		}
		if (current.partial && previousValue !== undefined) {
			props[key] = previousValue;
		}
	}
	if (current.partial) {
		for (const [key, value] of Object.entries(previous.props)) {
			if (!(key in props)) props[key] = value;
		}
	}
	return { ...current, props };
}

function mergePartialArray(
	current: unknown[],
	previous: unknown,
	currentPartial: boolean,
): unknown[] {
	if (!Array.isArray(previous)) return current;

	const hasElements = current.some(isElementNode);
	if (hasElements) {
		return current.map((item, index) => {
			if (!isElementNode(item)) return item;
			const previousItem = findPreviousElement(previous, item, index);
			return mergePartialTree(item, previousItem);
		});
	}

	// Scalar arrays (table rows, labels, steps) may be truncated mid-array.
	// Only fall back when the previous parse had at least as much data.
	if (
		currentPartial &&
		previous.length >= current.length &&
		previous.length > 0
	) {
		return previous;
	}
	return current;
}

function findPreviousElement(
	previous: unknown[],
	item: ElementNode,
	index: number,
): ElementNode | null {
	const byId = item.statementId
		? previous.find(
				(candidate): candidate is ElementNode =>
					isElementNode(candidate) &&
					candidate.statementId === item.statementId,
			)
		: undefined;
	if (byId) return byId;
	const byIndex = previous[index];
	return isElementNode(byIndex) ? byIndex : null;
}

export function hasPartialNode(node: ElementNode | null): boolean {
	if (!node) return false;
	if (node.partial) return true;
	return Object.values(node.props).some(hasPartialValue);
}

function hasPartialValue(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasPartialValue);
	if (isElementNode(value)) return hasPartialNode(value);
	return false;
}

function asStringArray(value: unknown): string[] | null {
	if (
		!Array.isArray(value) ||
		!value.every((item): item is string => typeof item === "string")
	) {
		return null;
	}
	return value;
}

function asStringMatrix(value: unknown): string[][] | null {
	if (!Array.isArray(value)) return null;
	const rows: string[][] = [];
	for (const row of value) {
		const cells = asStringArray(row);
		if (!cells) return null;
		rows.push(cells);
	}
	return rows;
}

function asNumberArray(value: unknown): number[] | null {
	if (
		!Array.isArray(value) ||
		!value.every(
			(item): item is number =>
				typeof item === "number" && Number.isFinite(item),
		)
	) {
		return null;
	}
	return value;
}

/**
 * Final-shape validation beyond JSON Schema (equal chart arrays, non-empty
 * table header, known component names). Invalid data falls back to source.
 */
export function checkOpenUiShape(
	node: ElementNode,
): OpenUiRenderFailure | null {
	switch (node.typeName) {
		case "Stack":
		case "Row": {
			const children = node.props.children;
			if (!Array.isArray(children)) return "invalid";
			for (const child of children) {
				if (!isElementNode(child)) return "invalid";
				const failure = checkOpenUiShape(child);
				if (failure) return failure;
			}
			if (
				node.props.gap !== undefined &&
				!["sm", "md", "lg"].includes(String(node.props.gap))
			) {
				return "invalid";
			}
			return null;
		}
		case "Text": {
			if (typeof node.props.text !== "string") return "invalid";
			const variant = node.props.variant;
			if (
				variant !== undefined &&
				!["body", "heading", "caption", "code"].includes(String(variant))
			) {
				return "invalid";
			}
			return null;
		}
		case "Table": {
			const columns = asStringArray(node.props.columns);
			const rows = asStringMatrix(node.props.rows);
			if (!columns || !rows || columns.length === 0) return "invalid";
			if (
				node.props.caption !== undefined &&
				typeof node.props.caption !== "string"
			) {
				return "invalid";
			}
			return null;
		}
		case "Stat": {
			if (
				typeof node.props.label !== "string" ||
				typeof node.props.value !== "string" ||
				(node.props.hint !== undefined && typeof node.props.hint !== "string")
			) {
				return "invalid";
			}
			return null;
		}
		case "BarChart": {
			const labels = asStringArray(node.props.labels);
			const values = asNumberArray(node.props.values);
			if (
				typeof node.props.title !== "string" ||
				!labels ||
				!values ||
				labels.length !== values.length ||
				values.some((value) => value < 0)
			) {
				return "invalid";
			}
			if (
				node.props.unit !== undefined &&
				typeof node.props.unit !== "string"
			) {
				return "invalid";
			}
			return null;
		}
		case "Steps": {
			if (
				typeof node.props.title !== "string" ||
				!asStringArray(node.props.steps)
			) {
				return "invalid";
			}
			return null;
		}
		case "Callout": {
			if (
				typeof node.props.title !== "string" ||
				typeof node.props.body !== "string"
			) {
				return "invalid";
			}
			const tone = node.props.tone;
			if (
				tone !== undefined &&
				!["info", "success", "warning", "danger"].includes(String(tone))
			) {
				return "invalid";
			}
			return null;
		}
		default:
			return "invalid";
	}
}

function exceedsShortText(value: unknown): boolean {
	return (
		typeof value === "string" && value.length > OPENUI_LIMITS.maxShortTextChars
	);
}

/** Size guard checked before rendering; oversized blocks keep their source. */
export function checkOpenUiLimits(
	node: ElementNode,
): OpenUiRenderFailure | null {
	let nodes = 0;

	const visit = (current: ElementNode): OpenUiRenderFailure | null => {
		nodes += 1;
		if (nodes > OPENUI_LIMITS.maxNodes) return "tooLarge";

		switch (current.typeName) {
			case "Stack":
			case "Row": {
				const children = current.props.children;
				if (!Array.isArray(children)) return "invalid";
				if (children.length > OPENUI_LIMITS.maxChildren) return "tooLarge";
				for (const child of children) {
					if (!isElementNode(child)) return "invalid";
					const failure = visit(child);
					if (failure) return failure;
				}
				return null;
			}
			case "Text": {
				const text = current.props.text;
				return typeof text === "string" &&
					text.length > OPENUI_LIMITS.maxTextChars
					? "tooLarge"
					: null;
			}
			case "Table": {
				const columns = asStringArray(current.props.columns);
				const rows = asStringMatrix(current.props.rows);
				if (!columns || !rows) return "invalid";
				if (
					exceedsShortText(current.props.caption) ||
					columns.length > OPENUI_LIMITS.maxTableColumns ||
					rows.length > OPENUI_LIMITS.maxTableRows ||
					columns.length * rows.length > OPENUI_LIMITS.maxTableCells ||
					columns.some(
						(column) => column.length > OPENUI_LIMITS.maxTableCellChars,
					) ||
					rows.some((row) =>
						row.some((cell) => cell.length > OPENUI_LIMITS.maxTableCellChars),
					)
				) {
					return "tooLarge";
				}
				return null;
			}
			case "BarChart": {
				const labels = asStringArray(current.props.labels);
				const values = asNumberArray(current.props.values);
				if (!labels || !values) return "invalid";
				if (
					exceedsShortText(current.props.title) ||
					exceedsShortText(current.props.unit) ||
					labels.length > OPENUI_LIMITS.maxChartPoints ||
					labels.some(
						(label) => label.length > OPENUI_LIMITS.maxChartLabelChars,
					)
				) {
					return "tooLarge";
				}
				return null;
			}
			case "Steps": {
				const steps = asStringArray(current.props.steps);
				if (!steps) return "invalid";
				if (
					exceedsShortText(current.props.title) ||
					steps.length > OPENUI_LIMITS.maxSteps ||
					steps.some((step) => step.length > OPENUI_LIMITS.maxStepChars)
				) {
					return "tooLarge";
				}
				return null;
			}
			case "Callout": {
				const body = current.props.body;
				if (typeof body !== "string") return "invalid";
				if (exceedsShortText(current.props.title)) return "tooLarge";
				return body.length > OPENUI_LIMITS.maxCalloutBodyChars
					? "tooLarge"
					: null;
			}
			case "Stat": {
				const fields = [
					current.props.label,
					current.props.value,
					current.props.hint,
				];
				return fields.some(
					(field) =>
						typeof field === "string" &&
						field.length > OPENUI_LIMITS.maxShortTextChars,
				)
					? "tooLarge"
					: null;
			}
			default:
				return "invalid";
		}
	};

	return visit(node);
}

/**
 * Resolve one parser snapshot. During streaming, the last structurally valid
 * tree supplies props for nodes that are still incomplete. Once the fence is
 * settled, invalid / oversized / unresolved trees fall back to their source.
 */
export function resolveOpenUiBlock(input: {
	source: string;
	result: ParseResult;
	streaming: boolean;
	lastValid: ElementNode | null;
}): ResolveOpenUiBlockResult {
	const { source, result, streaming } = input;
	let lastValid = input.lastValid;

	if (!source.trim()) {
		return { view: { kind: "failed", reason: "empty", source }, lastValid };
	}
	if (source.length > OPENUI_MAX_SOURCE_CHARS) {
		return { view: { kind: "failed", reason: "tooLarge", source }, lastValid };
	}

	const errors = fatalOpenUiErrors(result);
	const limitFailure = result.root ? checkOpenUiLimits(result.root) : null;
	if (limitFailure === "tooLarge") {
		return { view: { kind: "failed", reason: "tooLarge", source }, lastValid };
	}

	if (!streaming) {
		if (result.meta.incomplete || hasPartialNode(result.root)) {
			return {
				view: { kind: "failed", reason: "incomplete", source },
				lastValid,
			};
		}
		if (
			errors.length > 0 ||
			result.meta.unresolved.length > 0 ||
			Object.keys(result.stateDeclarations).length > 0 ||
			result.queryStatements.length > 0 ||
			result.mutationStatements.length > 0
		) {
			return { view: { kind: "failed", reason: "invalid", source }, lastValid };
		}
		if (!result.root) {
			return { view: { kind: "failed", reason: "empty", source }, lastValid };
		}
		const failure = checkOpenUiShape(result.root);
		if (failure) {
			return { view: { kind: "failed", reason: failure, source }, lastValid };
		}
		return {
			view: { kind: "ready", root: result.root, source },
			lastValid: result.root,
		};
	}

	const structurallyValid =
		Boolean(result.root) && errors.length === 0 && !hasPartialNode(result.root);
	if (structurallyValid && result.root) lastValid = result.root;

	const current = errors.length === 0 ? result.root : null;
	const root = mergePartialTree(current, lastValid);
	return { view: { kind: "streaming", root, source }, lastValid };
}
