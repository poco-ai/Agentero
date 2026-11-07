import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
	editorChrome,
	editorColorScheme,
	editorSyntaxHighlight,
} from "@/components/viewer/text-editor-theme";
import { readSourceDocument, sourceDocument } from "@/lib/markdown/source-text";
import {
	markdownSourceHighlight,
	markdownSourceWithFrontmatter,
} from "./markdown-source-language";

const sourceLayout = EditorView.theme({
	"& .cm-content": {
		maxWidth: "var(--markdown-source-width, none)",
		marginInline: "auto",
		width: "100%",
		paddingBlock: "1rem 5rem",
	},
	"& .cm-line": { paddingInline: "1rem" },
});

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
			basicSetup,
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
