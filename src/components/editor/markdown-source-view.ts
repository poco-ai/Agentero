import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
	bracketMatching,
	defaultHighlightStyle,
	foldGutter,
	foldKeymap,
	indentOnInput,
	syntaxHighlighting,
} from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
	crosshairCursor,
	drawSelection,
	dropCursor,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import {
	editorChrome,
	editorColorScheme,
	editorSyntaxHighlight,
} from "@/components/viewer/text-editor-theme";
import i18n from "@/i18n";
import {
	type MarkdownSourceFormat,
	sourceFormatKeymap,
	sourceFormatTransaction,
} from "@/lib/markdown/source-format";
import { readSourceDocument, sourceDocument } from "@/lib/markdown/source-text";
import {
	markdownSourceHighlight,
	markdownSourceWithFrontmatter,
} from "./markdown-source-language";
import { markdownSourceLineNumberStyle } from "./markdown-source-layout";

const sourceLayout = EditorView.theme({
	"& .cm-content": { paddingBlock: "1rem 5rem" },
	"& .cm-line": { paddingInline: "1rem" },
	// The source surface itself is capped at markdownMaxWidth in the editor
	// shell, which keeps the gutter inside the centered column.
	"& .cm-lineNumbers": markdownSourceLineNumberStyle,
	"& .cm-gutters.cm-gutters-before": { borderRightWidth: "0" },
	"& .cm-activeLine, & .cm-gutters .cm-activeLineGutter": {
		backgroundColor: "color-mix(in oklab, var(--foreground) 6%, transparent)",
	},
	// Match the line number's first visual row, even on wrapped lines.
	"& .cm-foldGutter .cm-source-fold": {
		display: "grid",
		placeItems: "center",
		inlineSize: "1em",
		blockSize: "1lh",
		padding: "0",
		cursor: "pointer",
	},
	"& .cm-source-fold > svg": {
		display: "block",
		inlineSize: "0.8em",
		blockSize: "0.8em",
		pointerEvents: "none",
	},
	"& .cm-source-fold-open > svg": { transform: "rotate(90deg)" },
});

function sourceFoldMarker(open: boolean): HTMLElement {
	const marker = document.createElement("span");
	marker.className = open
		? "cm-source-fold cm-source-fold-open"
		: "cm-source-fold";
	marker.title = i18n.t(
		open ? "editor:source.foldLine" : "editor:source.unfoldLine",
	);

	const svgNamespace = "http://www.w3.org/2000/svg";
	const icon = document.createElementNS(svgNamespace, "svg");
	icon.setAttribute("viewBox", "0 0 16 16");
	icon.setAttribute("aria-hidden", "true");
	const path = document.createElementNS(svgNamespace, "path");
	path.setAttribute("d", "M6 4l4 4-4 4");
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", "currentColor");
	path.setAttribute("stroke-width", "1.75");
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	icon.append(path);
	marker.append(icon);
	return marker;
}

// basicSetup has a fixed fold gutter. Compose the same public extensions
// here so the source editor can draw its own marker without a second gutter.
const sourceSetup = [
	lineNumbers(),
	highlightActiveLineGutter(),
	highlightSpecialChars(),
	history(),
	foldGutter({ markerDOM: sourceFoldMarker }),
	drawSelection(),
	dropCursor(),
	EditorState.allowMultipleSelections.of(true),
	indentOnInput(),
	syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
	bracketMatching(),
	closeBrackets(),
	autocompletion(),
	rectangularSelection(),
	crosshairCursor(),
	highlightActiveLine(),
	highlightSelectionMatches(),
	keymap.of([
		...closeBracketsKeymap,
		...defaultKeymap,
		...searchKeymap,
		...historyKeymap,
		...foldKeymap,
		...completionKeymap,
		...lintKeymap,
	]),
];

const preferences = new Compartment();

export type SourceViewPreferences = {
	phrases: Record<string, string>;
	dark: boolean;
};

function sourcePreferences({ dark, phrases }: SourceViewPreferences) {
	return [
		editorColorScheme(dark),
		EditorState.phrases.of(phrases),
		EditorView.contentAttributes.of({
			"aria-label": phrases["Markdown source"],
		}),
	];
}

export function configureMarkdownSourceView(
	view: EditorView,
	prefs: SourceViewPreferences,
) {
	if (preferences.get(view.state))
		view.dispatch({
			effects: preferences.reconfigure(sourcePreferences(prefs)),
		});
}

export function createMarkdownSourceView(parent: HTMLElement) {
	return new EditorView({ parent });
}

function sourceFormatCommand(format: MarkdownSourceFormat) {
	return (view: EditorView) => {
		const transaction = sourceFormatTransaction(view.state, format);
		if (!transaction) return false;
		view.dispatch({ ...transaction, scrollIntoView: true });
		return true;
	};
}

const sourceFormatBindings = sourceFormatKeymap.map(({ key, format }) => ({
	key,
	run: sourceFormatCommand(format),
}));

export function loadMarkdownSourceView(
	view: EditorView,
	raw: string,
	{
		line = 1,
		offset = 0,
		save,
		update,
		prefs,
	}: {
		line?: number;
		offset?: number;
		save: () => void;
		update: (read: () => string) => void;
		prefs: SourceViewPreferences;
	},
) {
	const { doc, endings } = sourceDocument(raw);
	const state = EditorState.create({
		doc,
		extensions: [
			sourceSetup,
			endings,
			editorChrome,
			preferences.of(sourcePreferences(prefs)),
			markdownSourceWithFrontmatter,
			markdownSourceHighlight,
			editorSyntaxHighlight,
			EditorView.lineWrapping,
			sourceLayout,
			Prec.highest(
				keymap.of([
					...sourceFormatBindings,
					{ key: "Mod-/", run: () => true },
					{
						key: "Mod-s",
						scope: "editor search-panel",
						run: () => {
							save();
							return true;
						},
					},
				]),
			),
			EditorView.updateListener.of((change) => {
				if (!change.docChanged) return;
				const state = change.state;
				let snapshot: string | undefined;
				update(() => (snapshot ??= readSourceDocument(state)));
			}),
		],
	});
	// setState keeps the EditorView/DOM instance and starts a fresh undo history.
	const target = state.doc.line(Math.max(1, Math.min(line, state.doc.lines)));
	view.setState(
		state.update({
			selection: { anchor: Math.min(target.from + offset, target.to) },
		}).state,
	);
}
