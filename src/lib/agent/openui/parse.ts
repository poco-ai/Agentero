import {
	createStreamingParser,
	type ElementNode,
	isElementNode,
	type ParseResult,
	type StreamParser,
	type ValidationError,
} from "@openuidev/lang-core";
import { type BlockName, blockProps, OPENUI_SCHEMA } from "./catalog";
import {
	isOpenUiLanguage,
	OPENUI_LIMITS,
	OPENUI_MAX_SOURCE_CHARS,
	OPENUI_ROOT_COMPONENT,
} from "./config";

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

/**
 * Final-shape validation reuses the same Zod props that produced the parser
 * schema. The parser already drops missing/typed fields; this catches unknown
 * components, semantic refinements (chart length, positive ranges) and plain
 * objects where child elements are required.
 */
export function validateOpenUiShape(
	node: ElementNode,
): OpenUiRenderFailure | null {
	let invalid = false;

	const visit = (current: ElementNode) => {
		if (invalid) return;
		const schema = blockProps[current.typeName as BlockName];
		if (!schema?.safeParse(current.props).success) {
			invalid = true;
			return;
		}
		if ("children" in current.props) {
			const children = current.props.children;
			if (!Array.isArray(children) || !children.every(isElementNode)) {
				invalid = true;
				return;
			}
			for (const child of children) visit(child);
		}
	};

	visit(node);
	return invalid ? "invalid" : null;
}

function arrayWithin(value: unknown, max: number): boolean {
	return Array.isArray(value) && value.length <= max;
}

function stringWithin(value: unknown, max: number): boolean {
	return typeof value === "string" && value.length <= max;
}

function stringsWithin(
	value: unknown,
	maxItems: number,
	maxChars: number,
): boolean {
	return (
		Array.isArray(value) &&
		value.length <= maxItems &&
		value.every((item) => typeof item === "string" && item.length <= maxChars)
	);
}

function shortText(value: unknown): boolean {
	return (
		value === undefined ||
		(typeof value === "string" &&
			value.length <= OPENUI_LIMITS.maxShortTextChars)
	);
}

function tableWithin(props: Record<string, unknown>): boolean {
	const columns = Array.isArray(props.columns) ? props.columns : [];
	const rows = Array.isArray(props.rows) ? props.rows : [];
	return (
		columns.length <= OPENUI_LIMITS.maxTableColumns &&
		rows.length <= OPENUI_LIMITS.maxTableRows &&
		columns.length * rows.length <= OPENUI_LIMITS.maxTableCells &&
		columns.every(
			(column) =>
				typeof column === "string" &&
				column.length <= OPENUI_LIMITS.maxTableCellChars,
		) &&
		rows.every(
			(row) =>
				Array.isArray(row) &&
				row.every(
					(cell) =>
						typeof cell === "string" &&
						cell.length <= OPENUI_LIMITS.maxTableCellChars,
				),
		) &&
		shortText(props.caption)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyValueWithin(props: Record<string, unknown>): boolean {
	const items = Array.isArray(props.items) ? props.items : [];
	return (
		items.length <= OPENUI_LIMITS.maxKeyValues &&
		items.every(
			(item) =>
				isRecord(item) &&
				shortText(item.label) &&
				(typeof item.value === "number" ||
					stringWithin(item.value, OPENUI_LIMITS.maxKeyValueChars)),
		)
	);
}

function timelineWithin(props: Record<string, unknown>): boolean {
	const items = Array.isArray(props.items) ? props.items : [];
	return (
		shortText(props.title) &&
		items.length <= OPENUI_LIMITS.maxTimelineItems &&
		items.every(
			(item) =>
				isRecord(item) &&
				shortText(item.title) &&
				(item.description === undefined ||
					stringWithin(item.description, OPENUI_LIMITS.maxTimelineTextChars)),
		)
	);
}

function treeWithin(props: Record<string, unknown>): boolean {
	const items = Array.isArray(props.items) ? props.items : [];
	return (
		shortText(props.title) &&
		items.length <= OPENUI_LIMITS.maxTreeItems &&
		items.every((item) => isRecord(item) && shortText(item.label))
	);
}

function sourceListWithin(props: Record<string, unknown>): boolean {
	const sources = Array.isArray(props.sources) ? props.sources : [];
	return (
		sources.length <= OPENUI_LIMITS.maxSources &&
		sources.every(
			(source) =>
				isRecord(source) &&
				shortText(source.label) &&
				(source.detail === undefined ||
					stringWithin(source.detail, OPENUI_LIMITS.maxSourceDetailChars)),
		)
	);
}

function chartWithin(props: Record<string, unknown>): boolean {
	const labels = Array.isArray(props.labels) ? props.labels : [];
	return (
		shortText(props.title) &&
		shortText(props.unit) &&
		labels.length <= OPENUI_LIMITS.maxChartPoints &&
		labels.every(
			(label) =>
				typeof label === "string" &&
				label.length <= OPENUI_LIMITS.maxChartLabelChars,
		)
	);
}

const LIMIT_RULES: Record<
	BlockName,
	(props: Record<string, unknown>) => boolean
> = {
	Stack: (props) => arrayWithin(props.children, OPENUI_LIMITS.maxChildren),
	Row: (props) => arrayWithin(props.children, OPENUI_LIMITS.maxChildren),
	Card: (props) =>
		shortText(props.title) &&
		arrayWithin(props.children, OPENUI_LIMITS.maxChildren),
	Text: (props) => stringWithin(props.text, OPENUI_LIMITS.maxTextChars),
	Badge: (props) => shortText(props.label),
	Callout: (props) =>
		shortText(props.title) &&
		stringWithin(props.body, OPENUI_LIMITS.maxCalloutBodyChars),
	KeyValue: keyValueWithin,
	Table: tableWithin,
	Stat: (props) =>
		shortText(props.label) && shortText(props.value) && shortText(props.hint),
	Progress: (props) => shortText(props.label),
	Steps: (props) =>
		shortText(props.title) &&
		stringsWithin(
			props.steps,
			OPENUI_LIMITS.maxSteps,
			OPENUI_LIMITS.maxStepChars,
		),
	BarChart: chartWithin,
	LineChart: chartWithin,
	Quote: (props) =>
		stringWithin(props.text, OPENUI_LIMITS.maxTextChars) &&
		shortText(props.source),
	Code: (props) =>
		stringWithin(props.code, OPENUI_LIMITS.maxCodeChars) &&
		shortText(props.language),
	Math: (props) => stringWithin(props.tex, OPENUI_LIMITS.maxMathChars),
	Divider: (props) => shortText(props.label),
	List: (props) =>
		stringsWithin(
			props.items,
			OPENUI_LIMITS.maxListItems,
			OPENUI_LIMITS.maxListItemChars,
		),
	Timeline: timelineWithin,
	Tree: treeWithin,
	TagList: (props) =>
		stringsWithin(props.tags, OPENUI_LIMITS.maxTags, OPENUI_LIMITS.maxTagChars),
	SourceList: sourceListWithin,
};

/** Size guard checked after shape validation; oversized blocks keep source. */
export function checkOpenUiLimits(
	node: ElementNode,
): OpenUiRenderFailure | null {
	let nodes = 0;
	let failure: OpenUiRenderFailure | null = null;

	const visit = (current: ElementNode) => {
		if (failure) return;
		nodes += 1;
		if (nodes > OPENUI_LIMITS.maxNodes) {
			failure = "tooLarge";
			return;
		}
		const rule = LIMIT_RULES[current.typeName as BlockName];
		if (!rule) {
			failure = "invalid";
			return;
		}
		if (!rule(current.props)) {
			failure = "tooLarge";
			return;
		}
		const children = current.props.children;
		if (Array.isArray(children)) {
			for (const child of children) {
				if (isElementNode(child)) visit(child);
			}
		}
	};

	visit(node);
	return failure;
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
		const shapeFailure = validateOpenUiShape(result.root);
		if (shapeFailure) {
			return {
				view: { kind: "failed", reason: shapeFailure, source },
				lastValid,
			};
		}
		const limitFailure = checkOpenUiLimits(result.root);
		if (limitFailure) {
			return {
				view: { kind: "failed", reason: limitFailure, source },
				lastValid,
			};
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
