import {
	HighlightStyle,
	syntaxHighlighting,
	syntaxTree,
} from "@codemirror/language";
import { type Extension, Prec, type Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { texTokenClass } from "@/lib/tex/highlight";

/**
 * Editor surface follows the app theme. Selectors start with `&` so they
 * match CodeMirror's built-in `&light` / `&dark` rules (two classes). This
 * extension is highest precedence because style modules mount in reverse
 * extension order — an earlier theme would otherwise paint over these.
 *
 * Token colors live in `editorHighlight`, not here.
 */
export const editorChrome: Extension = Prec.highest(
	EditorView.theme({
		"&": {
			height: "100%",
			backgroundColor: "var(--background)",
			color: "var(--foreground)",
		},
		"& .cm-scroller": {
			fontFamily: "var(--cm-content-font, var(--font-mono))",
			lineHeight: "var(--cm-content-leading, 1.65)",
		},
		"& .cm-gutters": {
			backgroundColor: "transparent",
			color: "var(--muted-foreground)",
			borderRight: "1px solid var(--border)",
		},
		"& .cm-activeLine": {
			backgroundColor: "color-mix(in oklab, var(--foreground) 6%, transparent)",
		},
		"& .cm-activeLineGutter": {
			backgroundColor: "color-mix(in oklab, var(--foreground) 8%, transparent)",
		},
		"& .cm-content": { caretColor: "var(--foreground)" },
		"& .cm-cursor, & .cm-dropCursor": {
			borderLeftColor: "var(--foreground)",
		},
		"&.cm-focused": { outline: "none" },
		// Focused selection is `&light.cm-focused > …` (five classes). A
		// matching selector is one class short, so the wash has to win outright.
		"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
			{
				backgroundColor:
					"color-mix(in oklab, var(--foreground) 16%, transparent) !important",
			},
		"& .cm-selectionBackground, & .cm-content ::selection": {
			backgroundColor:
				"color-mix(in oklab, var(--foreground) 16%, transparent)",
		},
		"& .cm-selectionMatch": {
			backgroundColor:
				"color-mix(in oklab, var(--foreground) 12%, transparent)",
		},
		"& .cm-searchMatch": {
			backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)",
		},
		"& .cm-searchMatch.cm-searchMatch-selected": {
			backgroundColor: "color-mix(in oklab, var(--primary) 36%, transparent)",
		},
		"&.cm-focused .cm-matchingBracket": {
			backgroundColor:
				"color-mix(in oklab, var(--foreground) 14%, transparent)",
		},
		"&.cm-focused .cm-nonmatchingBracket": {
			backgroundColor:
				"color-mix(in oklab, var(--destructive) 28%, transparent)",
		},
		"& .cm-foldPlaceholder": {
			backgroundColor: "transparent",
			border: "none",
			color: "var(--muted-foreground)",
		},
		"& .cm-panels": {
			backgroundColor: "var(--muted)",
			color: "var(--foreground)",
		},
		"& .cm-textfield": {
			backgroundColor: "var(--background)",
			color: "var(--foreground)",
			border: "1px solid var(--border)",
		},
		"& .cm-button": {
			backgroundImage: "none",
			backgroundColor: "var(--secondary)",
			color: "var(--secondary-foreground)",
			border: "1px solid var(--border)",
		},
		"& .cm-tooltip": {
			backgroundColor: "var(--popover)",
			color: "var(--popover-foreground)",
			border: "1px solid var(--border)",
		},
		"& .cm-tooltip.cm-tooltip-autocomplete > ul": {
			fontFamily: "var(--font-mono)",
		},
		"& .cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]": {
			background: "var(--accent)",
			color: "var(--accent-foreground)",
		},
		"& .cm-tooltip-above .cm-tooltip-arrow:before, & .cm-tooltip-above .cm-tooltip-arrow:after":
			{
				borderTopColor: "var(--popover)",
			},
		"& .cm-tooltip-below .cm-tooltip-arrow:before, & .cm-tooltip-below .cm-tooltip-arrow:after":
			{
				borderBottomColor: "var(--popover)",
			},
	}),
);

/**
 * Tell CodeMirror which scheme is active so `light-dark()` and its `&dark`
 * rules follow the app, not the OS default.
 */
export function editorColorScheme(dark: boolean): Extension {
	return EditorView.theme(
		{ "&": { colorScheme: dark ? "dark" : "light" } },
		dark ? { dark: true } : undefined,
	);
}

/**
 * A color in the active theme's hue. Lightness is chosen per scheme so the
 * same hue stays readable on `--background`; chroma is forced so the default
 * near-gray primary still reads as syntax, and custom themes keep their hue.
 */
function tone(
	lightness: readonly [onLight: number, onDark: number],
	chroma: number,
	hue = "h",
): string {
	const [onLight, onDark] = lightness;
	return `light-dark(oklch(from var(--primary) ${onLight} ${chroma} ${hue}), oklch(from var(--primary) ${onDark} ${chroma} ${hue}))`;
}

const command = tone([0.4, 0.86], 0.145);
const heading = tone([0.38, 0.88], 0.15, "calc(h + 18)");
const format = tone([0.42, 0.86], 0.13, "calc(h - 16)");
const reference = tone([0.4, 0.86], 0.14, "calc(h + 78)");
const environment = tone([0.4, 0.86], 0.13, "calc(h + 42)");
const structure = tone([0.4, 0.86], 0.12, "calc(h - 48)");
const math = tone([0.44, 0.84], 0.12, "calc(h + 62)");
const name = tone([0.42, 0.84], 0.12, "calc(h + 26)");
const literal = tone([0.45, 0.83], 0.115, "calc(h + 54)");
const value = tone([0.43, 0.84], 0.12, "calc(h - 28)");
const quiet = "color-mix(in oklab, var(--foreground) 68%, transparent)";

const editorHighlightStyle = HighlightStyle.define([
	{
		tag: [tags.comment, tags.meta, tags.documentMeta],
		color: "var(--muted-foreground)",
	},
	{
		tag: [
			tags.keyword,
			tags.controlKeyword,
			tags.moduleKeyword,
			tags.modifier,
			tags.monospace,
		],
		color: command,
	},
	{ tag: tags.definitionKeyword, color: structure },
	// `\cite` is quote and `\ref` / `\label` are label names in the grammar.
	{ tag: [tags.quote, tags.labelName], color: reference },
	{ tag: tags.heading, color: heading, fontWeight: "600" },
	{ tag: tags.strong, color: format, fontWeight: "600" },
	{ tag: tags.emphasis, color: format, fontStyle: "italic" },
	{
		tag: [
			tags.string,
			tags.regexp,
			tags.special(tags.string),
			tags.inserted,
			tags.processingInstruction,
		],
		color: literal,
	},
	{
		tag: [tags.number, tags.atom, tags.bool, tags.literal],
		color: value,
	},
	{
		tag: [
			tags.className,
			tags.typeName,
			tags.namespace,
			tags.propertyName,
			tags.macroName,
			tags.function(tags.variableName),
			tags.attributeName,
			tags.tagName,
		],
		color: name,
	},
	{
		tag: [
			tags.operator,
			tags.bracket,
			tags.punctuation,
			tags.separator,
			tags.derefOperator,
		],
		color: quiet,
	},
	{ tag: [tags.link, tags.url], color: command, textDecoration: "underline" },
	{ tag: [tags.invalid, tags.deleted], color: "var(--destructive)" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
]);

// The grammar tags most commands as one keyword. These marks split the
// visible ones into heading, format, reference, environment, and math.
const tokenMarks = new Map<string, Decoration>();

function tokenMark(className: string): Decoration {
	let mark = tokenMarks.get(className);
	if (!mark) {
		mark = Decoration.mark({ class: className });
		tokenMarks.set(className, mark);
	}
	return mark;
}

function texTokenMarks(view: EditorView): DecorationSet {
	const marks: Range<Decoration>[] = [];
	const tree = syntaxTree(view.state);
	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.from === node.to) return;
				const className = texTokenClass(node.name);
				if (!className) return;
				marks.push(tokenMark(className).range(node.from, node.to));
			},
		});
	}
	return Decoration.set(marks, true);
}

const texCommandHighlight = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = texTokenMarks(view);
		}
		update(update: ViewUpdate) {
			if (
				update.docChanged ||
				update.viewportChanged ||
				syntaxTree(update.state) !== syntaxTree(update.startState)
			) {
				this.decorations = texTokenMarks(update.view);
			}
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);

export const editorSyntaxHighlight = syntaxHighlighting(editorHighlightStyle);

/** Syntax colors derived from the app theme. Always on; `basicSetup`'s highlighter is only a fallback. */
export const editorHighlight: Extension = [
	editorSyntaxHighlight,
	texCommandHighlight,
	EditorView.theme({
		"& .cm-tex-cmd": { color: command },
		"& .cm-tex-heading": { color: heading, fontWeight: "600" },
		"& .cm-tex-format": { color: format },
		"& .cm-tex-format-bold": { fontWeight: "600" },
		"& .cm-tex-format-italic": { fontStyle: "italic" },
		"& .cm-tex-ref": { color: reference },
		"& .cm-tex-env": { color: environment },
		"& .cm-tex-structure": { color: structure },
		"& .cm-tex-math": { color: math },
		"& .cm-tex-link": { color: command, textDecoration: "underline" },
	}),
];
