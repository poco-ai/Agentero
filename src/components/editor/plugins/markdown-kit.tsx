import {
	BaseFootnoteDefinitionPlugin,
	BaseFootnoteReferencePlugin,
} from "@platejs/footnote";
import { MarkdownPlugin } from "@platejs/markdown";
import { KEYS } from "platejs";
import { MarkdownPastePlugin } from "@/components/editor/plugins/markdown-paste-plugin";
import { obsidianCalloutRules } from "@/lib/markdown/callout";
import { columnsRules } from "@/lib/markdown/columns";
import { htmlRules } from "@/lib/markdown/html";
import { imageGroupRules } from "@/lib/markdown/image-group";
import { MARKDOWN_REMARK_PLUGINS } from "@/lib/markdown/remark-plugins";
import { paragraphMarkdownRule } from "@/lib/markdown/serialize";
import { researchTableRules } from "@/lib/research-table/markdown";
import { wikiLinkRules } from "@/lib/wiki/wikilink-model";

export const MarkdownKit = [
	BaseFootnoteReferencePlugin.configure({
		options: {
			triggerQuery: (editor) => {
				const { selection } = editor;
				if (!selection || !editor.api.isCollapsed()) return true;
				const start = editor.api.before(selection, {
					distance: 2,
					unit: "character",
				});
				if (!start) return true;
				return (
					editor.api.string({
						anchor: start,
						focus: selection.anchor,
					}) !== "[["
				);
			},
		},
	}),
	BaseFootnoteDefinitionPlugin,
	MarkdownPlugin.configure({
		options: {
			plainMarks: [KEYS.suggestion, KEYS.comment],
			remarkPlugins: MARKDOWN_REMARK_PLUGINS,
			rules: {
				p: paragraphMarkdownRule,
				...researchTableRules,
				...wikiLinkRules,
				...obsidianCalloutRules,
				...imageGroupRules,
				...columnsRules,
				...htmlRules,
			},
		},
	}),
	MarkdownPastePlugin,
];
