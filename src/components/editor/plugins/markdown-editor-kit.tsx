"use client";

import {
	BlockquoteRules,
	BoldRules,
	CodeRules,
	HeadingRules,
	HighlightRules,
	HorizontalRuleRules,
	ItalicRules,
	MarkComboRules,
	StrikethroughRules,
	SubscriptRules,
	SuperscriptRules,
	UnderlineRules,
} from "@platejs/basic-nodes";
import {
	BlockquotePlugin,
	BoldPlugin,
	CodePlugin,
	H1Plugin,
	H2Plugin,
	H3Plugin,
	H4Plugin,
	H5Plugin,
	H6Plugin,
	HighlightPlugin,
	HorizontalRulePlugin,
	ItalicPlugin,
	KbdPlugin,
	StrikethroughPlugin,
	SubscriptPlugin,
	SuperscriptPlugin,
	UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import { CodeBlockRules } from "@platejs/code-block";
import {
	CodeBlockPlugin,
	CodeLinePlugin,
	CodeSyntaxPlugin,
} from "@platejs/code-block/react";
import { IndentPlugin } from "@platejs/indent/react";
import {
	BulletedListRules,
	isOrderedList,
	OrderedListRules,
	TaskListRules,
} from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { MathRules } from "@platejs/math";
import { EquationPlugin, InlineEquationPlugin } from "@platejs/math/react";
import { MentionPlugin } from "@platejs/mention/react";
import {
	TableCellHeaderPlugin,
	TableCellPlugin,
	TablePlugin,
	TableRowPlugin,
} from "@platejs/table/react";
import { common, createLowlight } from "lowlight";
import { KEYS, TrailingBlockPlugin } from "platejs";
import { ParagraphPlugin } from "platejs/react";
import { BlockquoteElement } from "@/components/editor/nodes/block/blockquote-node";
import {
	CodeBlockElement,
	CodeLineElement,
	CodeSyntaxLeaf,
} from "@/components/editor/nodes/block/code-block-node";
import {
	EquationElement,
	InlineEquationElement,
} from "@/components/editor/nodes/block/equation-node";
import {
	H1Element,
	H2Element,
	H3Element,
	H4Element,
	H5Element,
	H6Element,
} from "@/components/editor/nodes/block/heading-node";
import { HrElement } from "@/components/editor/nodes/block/hr-node";
import { BlockList } from "@/components/editor/nodes/block/list-node";
import { ParagraphElement } from "@/components/editor/nodes/block/paragraph-node";
import {
	TableCellElement,
	TableCellHeaderElement,
	TableElement,
	TableRowElement,
} from "@/components/editor/nodes/block/table-node";
import { MentionElement } from "@/components/editor/nodes/inline/mention-node";
import {
	CodeLeaf,
	HighlightLeaf,
	KbdLeaf,
} from "@/components/editor/nodes/leaf";
import { CalloutPlugin } from "@/components/editor/plugins/callout-plugin";
import { FindReplaceKit } from "@/components/editor/plugins/find-replace-kit";
import { LinkPlugin } from "@/components/editor/plugins/link-plugin";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { WikiBlockIdPlugin } from "@/components/editor/plugins/wiki-block-id-plugin";
import { WikiLinkPlugin } from "@/components/editor/plugins/wikilink-plugin";
import { handleCodeBlockDeleteBackward } from "@/lib/markdown/code-block-delete";
import { inlineMathInputRule } from "@/lib/markdown/inline-math-input-rule";

const lowlight = createLowlight(common);

const listTargets = [
	...KEYS.heading,
	KEYS.p,
	KEYS.blockquote,
	KEYS.codeBlock,
	KEYS.toggle,
	KEYS.img,
];

const headingBreak = { break: { empty: "reset" } } as const;

/** Full Plate kit for editing Markdown as WYSIWYG rich text. */
export const MarkdownEditorKit = [
	// Blocks
	ParagraphPlugin.withComponent(ParagraphElement),
	H1Plugin.configure({
		inputRules: [HeadingRules.markdown()],
		node: { component: H1Element },
		rules: headingBreak,
	}),
	H2Plugin.configure({
		inputRules: [HeadingRules.markdown()],
		node: { component: H2Element },
		rules: headingBreak,
	}),
	H3Plugin.configure({
		inputRules: [HeadingRules.markdown()],
		node: { component: H3Element },
		rules: headingBreak,
	}),
	H4Plugin.configure({
		inputRules: [HeadingRules.markdown()],
		node: { component: H4Element },
		rules: headingBreak,
	}),
	H5Plugin.configure({
		inputRules: [HeadingRules.markdown()],
		node: { component: H5Element },
		rules: headingBreak,
	}),
	H6Plugin.configure({
		inputRules: [HeadingRules.markdown()],
		node: { component: H6Element },
		rules: headingBreak,
	}),
	BlockquotePlugin.configure({
		inputRules: [BlockquoteRules.markdown()],
		node: { component: BlockquoteElement },
	}),
	CalloutPlugin,
	HorizontalRulePlugin.configure({
		inputRules: [
			HorizontalRuleRules.markdown({ variant: "-" }),
			HorizontalRuleRules.markdown({ variant: "_" }),
		],
		node: { component: HrElement },
	}),

	// Marks
	BoldPlugin.configure({
		inputRules: [
			BoldRules.markdown({ variant: "*" }),
			BoldRules.markdown({ variant: "_" }),
			MarkComboRules.markdown({ variant: "boldItalic" }),
		],
	}),
	ItalicPlugin.configure({
		inputRules: [
			ItalicRules.markdown({ variant: "*" }),
			ItalicRules.markdown({ variant: "_" }),
		],
	}),
	UnderlinePlugin.configure({ inputRules: [UnderlineRules.markdown()] }),
	StrikethroughPlugin.configure({
		inputRules: [StrikethroughRules.markdown()],
	}),
	CodePlugin.configure({
		inputRules: [CodeRules.markdown()],
		node: { component: CodeLeaf },
	}),
	SubscriptPlugin.configure({ inputRules: [SubscriptRules.markdown()] }),
	SuperscriptPlugin.configure({ inputRules: [SuperscriptRules.markdown()] }),
	HighlightPlugin.configure({
		inputRules: [HighlightRules.markdown({ variant: "==" })],
		node: { component: HighlightLeaf },
	}),
	KbdPlugin.withComponent(KbdLeaf),
	WikiBlockIdPlugin,

	// Indentation + lists
	// rem tracks root font-size (uiScale); 1.5rem == 24px at 100% so markers
	// and todo checkboxes (`-left-6` = 1.5rem) stay aligned when zoomed (#143).
	IndentPlugin.configure({
		inject: { targetPlugins: listTargets },
		options: { offset: 1.5, unit: "rem" },
	}),
	ListPlugin.configure({
		inputRules: [
			BulletedListRules.markdown({ variant: "-" }),
			BulletedListRules.markdown({ variant: "*" }),
			OrderedListRules.markdown({ variant: "." }),
			OrderedListRules.markdown({ variant: ")" }),
			TaskListRules.markdown({ checked: false }),
			TaskListRules.markdown({ checked: true }),
		],
		// Unordered: inject display:list-item on the block (official ListKit).
		// Ordered + todo: BlockList renders <ol>/<ul> wrappers (see block-list.tsx).
		// Never both — that paints a double bullet on unordered lists.
		inject: {
			nodeProps: {
				nodeKey: KEYS.listType,
				query: ({ nodeProps }) => {
					const element = nodeProps.element;
					if (!element?.listStyleType) return false;
					if (isOrderedList(element)) return false;
					if (element.listStyleType === "todo") return false;
					return true;
				},
				transformProps: ({ props }) => ({
					...props,
					role: "listitem",
					style: {
						...props.style,
						display: "list-item",
						listStylePosition: "outside",
					},
				}),
			},
			targetPlugins: listTargets,
		},
		render: { belowNodes: BlockList },
	}),

	// Code blocks
	// Override deleteBackward so empty-block Backspace unwraps instead of
	// jumping to an earlier code_line elsewhere in the document (#178).
	CodeBlockPlugin.configure({
		inputRules: [CodeBlockRules.markdown({ on: "match" })],
		node: { component: CodeBlockElement },
		options: { lowlight },
	}).overrideEditor(({ editor, tf: { deleteBackward } }) => ({
		transforms: {
			deleteBackward(unit) {
				if (handleCodeBlockDeleteBackward(editor)) return;
				deleteBackward(unit);
			},
		},
	})),
	CodeLinePlugin.withComponent(CodeLineElement),
	CodeSyntaxPlugin.withComponent(CodeSyntaxLeaf),

	// Tables
	TablePlugin.withComponent(TableElement),
	TableRowPlugin.withComponent(TableRowElement),
	TableCellPlugin.withComponent(TableCellElement),
	TableCellHeaderPlugin.withComponent(TableCellHeaderElement),

	// Math
	InlineEquationPlugin.configure({
		inputRules: [inlineMathInputRule],
		node: { component: InlineEquationElement },
	}),
	EquationPlugin.configure({
		inputRules: [MathRules.markdown({ on: "break", variant: "$$" })],
		node: { component: EquationElement },
	}),

	// Inline nodes
	// ImagePlugin is configured per-editor (uploadImage → ./assets/) in markdown-editor.tsx
	MentionPlugin.withComponent(MentionElement),
	WikiLinkPlugin,
	// Hand-typed `[label](url)` + open/edit UI (see link-plugin / link-node).
	LinkPlugin,

	// Find & replace (⌘F) — search highlight decorations
	...FindReplaceKit,

	// Always end with a paragraph so void blocks (image / HR / table) leave a
	// place to click, arrow-down, or type after the last content.
	TrailingBlockPlugin.configure({
		options: { type: KEYS.p },
	}),

	// Markdown serialization (MarkdownPlugin + footnotes + wikilink rules)
	...MarkdownKit,
];
