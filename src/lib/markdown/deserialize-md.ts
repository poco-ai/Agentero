import { MarkdownPlugin } from "@platejs/markdown";
import {
	type Descendant,
	ElementApi,
	type SlateEditor,
	type TElement,
	type TEquationElement,
	TextApi,
	type TText,
	type Value,
} from "platejs";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import { remarkRecoverInlineHtmlMarks } from "@/lib/markdown/highlight";
import {
	hasTexDelimiterMark,
	readTexDelimiter,
	stripTexDelimiterMarks,
	type TexDelimiter,
} from "@/lib/markdown/math-normalize";
import {
	markdownNeedsMdx,
	selectMarkdownRemarkPluginsForDeserialize,
} from "@/lib/markdown/remark-plugins";

/**
 * TeX that KaTeX can only render in display math: `\tag`, and the display-only
 * environments (`align`, `gather`, `equation`, `multline`, `flalign`,
 * `eqnarray`, `alignat`). Inline math is rendered with `displayMode: false`,
 * so these throw (`\tag works only in display equations`, `{align} can be
 * used only in display mode`). Notes written as `$…\tag{…}$` — and notes an
 * older pipeline saved that way after parsing a display formula as inline
 * math — would otherwise show KaTeX's red parse-error text instead of the
 * formula.
 */
const INLINE_DISPLAY_ONLY =
	/(?<!\\)\\tag\*?(?![a-zA-Z])|(?<!\\)\\begin\{(?:align|alignat|eqnarray|equation|flalign|gather|multline)\*?\}/;

/** Containers whose children are blocks, so promotion can recurse inside. */
const BLOCK_CONTAINERS = new Set(["blockquote", "callout"]);

type InlineEquation = TEquationElement & { type: "inline_equation" };

type DelimitedEquation = TEquationElement & { texDelimiter?: TexDelimiter };

/**
 * Move the invisible `\[…\]` / `\(…\)` marker `normalizeNoteMarkdownMath` left
 * in the TeX onto the Slate node, so the serializer can write the original
 * delimiter back instead of silently converting imported formulas to dollar
 * math (#1171). A marker that did not become math (the normalized shape failed
 * to parse) is dropped from the text leaf instead of reaching the editor.
 */
function adoptTexDelimiters(nodes: Descendant[]): void {
	for (const node of nodes) {
		if (TextApi.isText(node)) {
			if (hasTexDelimiterMark(node.text)) {
				node.text = stripTexDelimiterMarks(node.text);
			}
			continue;
		}
		if (!ElementApi.isElement(node)) continue;
		const element = node as TElement;
		if (
			(element.type === "equation" || element.type === "inline_equation") &&
			typeof (element as DelimitedEquation).texExpression === "string"
		) {
			const equation = element as DelimitedEquation;
			const { tex, delimiter } = readTexDelimiter(equation.texExpression);
			if (delimiter) {
				equation.texExpression = tex;
				equation.texDelimiter = delimiter;
			}
		}
		adoptTexDelimiters(element.children as Descendant[]);
	}
}

function isDisplayOnlyInlineEquation(node: Descendant): node is InlineEquation {
	const element = node as TEquationElement & { type?: string };
	return (
		element.type === "inline_equation" &&
		typeof element.texExpression === "string" &&
		INLINE_DISPLAY_ONLY.test(element.texExpression)
	);
}

function hasContent(children: readonly Descendant[]): boolean {
	return children.some((child) =>
		"text" in child ? (child as TText).text.length > 0 : true,
	);
}

/**
 * Strip whitespace at the cut edges of a split paragraph. Without this the
 * serializer encodes boundary spaces as `&#x20;` to preserve them, which
 * litters the saved Markdown around a promoted display formula.
 */
function trimmedRun(run: Descendant[]): Descendant[] {
	const out = [...run];
	const first = out[0];
	if (first && "text" in first) {
		out[0] = {
			...(first as TText),
			text: (first as TText).text.replace(/^\s+/, ""),
		} as Descendant;
	}
	const last = out[out.length - 1];
	if (last && "text" in last) {
		out[out.length - 1] = {
			...(last as TText),
			text: (last as TText).text.replace(/\s+$/, ""),
		} as Descendant;
	}
	return out;
}

function equationNode(equation: InlineEquation): TElement {
	const { texDelimiter } = equation as DelimitedEquation;
	return {
		type: "equation",
		texExpression: equation.texExpression,
		...(texDelimiter ? { texDelimiter } : {}),
		children: [{ text: "" }],
	} as TElement;
}

/**
 * Split a paragraph around display-only inline formulas: the surrounding text
 * keeps its own paragraph and each formula becomes a block equation (display
 * mode), where `\tag` / `align` render. A paragraph that is only the formula
 * becomes just the equation.
 */
function promoteParagraph(paragraph: TElement): TElement[] {
	const out: TElement[] = [];
	let run: Descendant[] = [];
	const flush = () => {
		const trimmed = trimmedRun(run);
		if (hasContent(trimmed)) {
			// A split paragraph must not keep one node id on several siblings;
			// markdown-authored paragraphs have no other block-level props.
			const { id: _id, ...rest } = paragraph as TElement & { id?: string };
			out.push({ ...rest, children: trimmed } as TElement);
		}
		run = [];
	};
	for (const child of paragraph.children) {
		if (isDisplayOnlyInlineEquation(child)) {
			flush();
			out.push(equationNode(child));
			continue;
		}
		run.push(child);
	}
	flush();
	return out;
}

/**
 * Promote inline equations with display-only TeX to block equations.
 *
 * Runs after Markdown deserialization, so it also repairs notes whose display
 * formulas were previously saved as inline `$…$`. Formulas inside list items,
 * headings and table cells are left alone: those containers cannot take a
 * block equation without restructuring the surrounding block.
 */
export function promoteDisplayOnlyInlineEquations(value: Value): Value {
	return value.flatMap<TElement>((node) => {
		const element = node as TElement;
		if (
			element.type === "p" &&
			Array.isArray(element.children) &&
			element.children.some(isDisplayOnlyInlineEquation)
		) {
			return promoteParagraph(element);
		}
		if (BLOCK_CONTAINERS.has(element.type) && Array.isArray(element.children)) {
			return [
				{
					...element,
					children: promoteDisplayOnlyInlineEquations(
						element.children as Value,
					),
				} as TElement,
			];
		}
		return [node];
	});
}

/**
 * Deserialize a Markdown body with only the remark plugins that body needs.
 *
 * Centralizes the `prepareMarkdownForDeserialize` + plugin-selection pair so
 * every editor surface (live editor, embeds, export, paste, external reload)
 * parses through the same trimmed pipeline. When the document has no `<` tag,
 * `withoutMdx` also skips Plate's `htmlToJsx` scan of the whole source.
 */
export function deserializeMarkdownBody(
	editor: SlateEditor,
	body: string,
	{ throwOnError = false } = {},
) {
	const prepared = prepareMarkdownForDeserialize(body || " ");
	const remarkPlugins = selectMarkdownRemarkPluginsForDeserialize(prepared);
	const withoutMdx = !markdownNeedsMdx(prepared);
	let mdxError: unknown = null;
	const value = editor.getApi(MarkdownPlugin).markdown.deserialize(prepared, {
		remarkPlugins,
		withoutMdx,
		onError: (error) => {
			if (throwOnError) throw error;
			mdxError = error;
		},
	});
	if (!mdxError || withoutMdx) {
		adoptTexDelimiters(value);
		return promoteDisplayOnlyInlineEquations(value);
	}

	// An unexpected MDX parse error drops us into Plate's
	// `markdownToSlateNodesSafely` recovery, which cuts the source at the first
	// `<name`-looking slice (it cannot tell math/code from JSX) and flattens the
	// whole tail into one inline block: most of the note silently disappears.
	// Re-parse without MDX so every block survives. Inline HTML marks
	// (`<mark>`, `<u>`, …) are raw `html` nodes in that pipeline, so recover
	// them into real marks instead of letting the next save escape the tags;
	// malformed tags stay literal text.
	logger.warn("markdown deserialize mdx failed; retrying without mdx", {
		chars: prepared.length,
		error: errorText(mdxError),
	});
	const recovered = editor
		.getApi(MarkdownPlugin)
		.markdown.deserialize(prepared, {
			remarkPlugins: [...remarkPlugins, remarkRecoverInlineHtmlMarks],
			withoutMdx: true,
		});
	adoptTexDelimiters(recovered);
	return promoteDisplayOnlyInlineEquations(recovered);
}
