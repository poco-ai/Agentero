/**
 * Reduced Plate kit for small Markdown editors embedded outside the note
 * editor (PDF comment cards): marks with their Markdown input rules, lists
 * ("- " grows a bullet), blockquotes, and the plain paragraph. Deliberately
 * excludes the wikilink / embed / table / math plugins so the viewer layer
 * can mount it without importing the wiki-embed graph (which reaches back
 * into viewer/pdf and would close a dependency cycle).
 */
import {
	BlockquoteRules,
	BoldRules,
	CodeRules,
	ItalicRules,
	StrikethroughRules,
	UnderlineRules,
} from "@platejs/basic-nodes";
import {
	BlockquotePlugin,
	BoldPlugin,
	CodePlugin,
	ItalicPlugin,
	StrikethroughPlugin,
	UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import { IndentPlugin } from "@platejs/indent/react";
import {
	BulletedListRules,
	isOrderedList,
	OrderedListRules,
	TaskListRules,
} from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { KEYS, TrailingBlockPlugin } from "platejs";
import { ParagraphPlugin } from "platejs/react";
import { BlockList } from "@/components/editor/nodes/block/list-node";
import { ParagraphElement } from "@/components/editor/nodes/block/paragraph-node";
import { MARKDOWN_REMARK_PLUGINS } from "@/lib/markdown/remark-plugins";

const commentListTargets = [KEYS.p, KEYS.blockquote];

/**
 * Marks serialize through the same remark pipeline as the note editor, so a
 * saved comment keeps Markdown source (wikilinks etc. stay literal text).
 */
export const CommentMarkdownKit = [
	ParagraphPlugin.withComponent(ParagraphElement),
	BoldPlugin.configure({
		inputRules: [
			BoldRules.markdown({ variant: "*" }),
			BoldRules.markdown({ variant: "_" }),
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
	}),
	BlockquotePlugin.configure({
		inputRules: [BlockquoteRules.markdown()],
	}),
	// rem tracks root font-size (uiScale) so list markers stay aligned when
	// zoomed (#143). The comment card uses a tighter gutter than the note
	// editor; the Streamdown preview mirrors it via `.comment-md` in index.css.
	IndentPlugin.configure({
		inject: { targetPlugins: commentListTargets },
		options: { offset: 1.15, unit: "rem" },
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
		// Unordered lists inject display:list-item on the block; ordered / todo
		// render <ol>/<ul> wrappers via BlockList (same split as the note kit).
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
			targetPlugins: commentListTargets,
		},
		render: { belowNodes: BlockList },
	}),
	TrailingBlockPlugin,
	MarkdownPlugin.configure({
		options: { remarkPlugins: MARKDOWN_REMARK_PLUGINS },
	}),
];
