import { toggleCodeBlock } from "@platejs/code-block";
import {
	ListStyleType,
	toggleList,
	toggleListByPathUnSet,
} from "@platejs/list";
import {
	KEYS,
	RangeApi,
	type SlateEditor,
	type TCodeBlockElement,
	type TElement,
	type TText,
} from "platejs";
import {
	type EditorLinkTemplateKind,
	insertEditorLinkTemplate,
} from "@/lib/markdown/editor-context-menu";
import { findWikiCompletionTrigger } from "@/lib/wiki-completion";

export type SlashCommandId =
	| "heading1"
	| "heading2"
	| "heading3"
	| "bulletedList"
	| "numberedList"
	| "todoList"
	| "quote"
	| "codeBlock"
	| "mermaid"
	| "internalLink"
	| "externalLink"
	| "callout";

export type SlashCommand = {
	id: SlashCommandId;
	labelKey:
		| "slashCommand.commands.heading1"
		| "slashCommand.commands.heading2"
		| "slashCommand.commands.heading3"
		| "slashCommand.commands.bulletedList"
		| "slashCommand.commands.numberedList"
		| "slashCommand.commands.todoList"
		| "slashCommand.commands.quote"
		| "slashCommand.commands.codeBlock"
		| "slashCommand.commands.mermaid"
		| "slashCommand.commands.callout"
		| "contextMenu.insertWikiLink"
		| "contextMenu.insertExternalLink";
	keywords: readonly string[];
};

export type SlashCommandTrigger = {
	query: string;
	start: number;
	end: number;
};

export type SlashCommandTarget = SlashCommandTrigger & {
	path: number[];
};

export function isSlashCommandSubmitKey(key: string): key is "Enter" | "Tab" {
	return key === "Enter" || key === "Tab";
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		id: "heading1",
		labelKey: "slashCommand.commands.heading1",
		keywords: ["h1", "heading", "title", "一级标题", "标题"],
	},
	{
		id: "heading2",
		labelKey: "slashCommand.commands.heading2",
		keywords: ["h2", "heading", "subtitle", "二级标题", "标题"],
	},
	{
		id: "heading3",
		labelKey: "slashCommand.commands.heading3",
		keywords: ["h3", "heading", "subtitle", "三级标题", "标题"],
	},
	{
		id: "bulletedList",
		labelKey: "slashCommand.commands.bulletedList",
		keywords: ["bullet", "unordered", "ul", "无序列表", "列表"],
	},
	{
		id: "numberedList",
		labelKey: "slashCommand.commands.numberedList",
		keywords: ["number", "ordered", "ol", "有序列表", "编号", "列表"],
	},
	{
		id: "todoList",
		labelKey: "slashCommand.commands.todoList",
		keywords: ["todo", "task", "check", "待办", "任务", "列表"],
	},
	{
		id: "quote",
		labelKey: "slashCommand.commands.quote",
		keywords: ["quote", "blockquote", "引用"],
	},
	{
		id: "codeBlock",
		labelKey: "slashCommand.commands.codeBlock",
		keywords: ["code", "fence", "代码", "代码块"],
	},
	{
		id: "mermaid",
		labelKey: "slashCommand.commands.mermaid",
		keywords: [
			"mermaid",
			"diagram",
			"flowchart",
			"sequence",
			"流程图",
			"时序图",
		],
	},
	{
		id: "internalLink",
		labelKey: "contextMenu.insertWikiLink",
		keywords: [
			"internal link",
			"wikilink",
			"wiki",
			"link",
			"内部链接",
			"内链",
			"双链",
		],
	},
	{
		id: "externalLink",
		labelKey: "contextMenu.insertExternalLink",
		keywords: ["external link", "url", "web", "link", "外部链接", "链接"],
	},
	{
		id: "callout",
		labelKey: "slashCommand.commands.callout",
		keywords: ["callout", "note", "admonition", "提示", "标注"],
	},
];

/**
 * Match a live slash query ending at the collapsed cursor. The trigger must
 * start the text leaf or follow whitespace, which avoids URLs and ordinary
 * punctuation while still allowing `text /heading`.
 */
export function findSlashCommandTrigger(
	text: string,
	cursorOffset: number,
): SlashCommandTrigger | null {
	if (cursorOffset < 0 || cursorOffset > text.length) return null;
	if (findWikiCompletionTrigger(text, cursorOffset)) return null;
	const beforeCursor = text.slice(0, cursorOffset);
	const match = /(^|\s)\/([^\s/]*)$/u.exec(beforeCursor);
	if (!match) return null;
	const query = match[2] ?? "";
	return {
		query,
		start: cursorOffset - query.length - 1,
		end: cursorOffset,
	};
}

export function filterSlashCommands(
	query: string,
	resolveLabel: (command: SlashCommand) => string,
	options: { allowCallout?: boolean } = {},
): SlashCommand[] {
	const normalized = query.trim().toLocaleLowerCase();
	return SLASH_COMMANDS.filter((command) => {
		if (command.id === "callout" && options.allowCallout === false) {
			return false;
		}
		if (!normalized) return true;
		const terms = [resolveLabel(command), ...command.keywords];
		return terms.some((term) => term.toLocaleLowerCase().includes(normalized));
	});
}

type LiveSlashCommand = {
	blockPath: number[];
	trigger: SlashCommandTrigger;
};

function findLiveSlashCommand(
	editor: SlateEditor,
	target: SlashCommandTarget,
): LiveSlashCommand | null {
	const selection = editor.selection;
	if (!selection || !RangeApi.isCollapsed(selection)) return null;
	if (
		selection.anchor.offset !== target.end ||
		selection.anchor.path.join(",") !== target.path.join(",")
	) {
		return null;
	}
	const entry = editor.api.node(selection.anchor.path);
	const leaf = entry?.[0];
	if (!leaf || typeof (leaf as TText).text !== "string") return null;
	const trigger = findSlashCommandTrigger(
		(leaf as TText).text,
		selection.anchor.offset,
	);
	if (
		!trigger ||
		trigger.query !== target.query ||
		trigger.start !== target.start ||
		trigger.end !== target.end
	) {
		return null;
	}
	const block = editor.api.block();
	if (!block) return null;
	return { blockPath: block[1], trigger };
}

function canInsertCallout(editor: SlateEditor, blockPath: number[]): boolean {
	if (blockPath.length !== 1) return false;
	return !editor.api.above({
		match: { type: editor.getType(KEYS.callout) },
	});
}

function consumeSlashCommand(
	editor: SlateEditor,
	trigger: SlashCommandTrigger,
): void {
	const selection = editor.selection;
	if (!selection) return;
	const start = {
		path: selection.anchor.path,
		offset: trigger.start,
	};
	const end = {
		path: selection.anchor.path,
		offset: trigger.end,
	};
	editor.tf.delete({ at: { anchor: start, focus: end } });
}

function clearCurrentList(editor: SlateEditor): void {
	const block = editor.api.block();
	if (!block) return;
	const node = block[0] as TElement & {
		checked?: boolean;
		indent?: number;
		listStyleType?: string;
	};
	if (
		node.listStyleType === undefined &&
		node.checked === undefined &&
		node.indent === undefined
	) {
		return;
	}
	toggleListByPathUnSet(editor, block);
}

function applyListStyle(editor: SlateEditor, listStyleType: string): void {
	const block = editor.api.block();
	const currentStyle = (block?.[0] as TElement & { listStyleType?: string })
		?.listStyleType;
	if (currentStyle === listStyleType) return;
	toggleList(editor, { listStyleType });
}

function applyBlockType(editor: SlateEditor, type: string): void {
	clearCurrentList(editor);
	const block = editor.api.block();
	if (!block || (block[0] as TElement).type === type) return;
	editor.tf.setNodes({ type }, { at: block[1] });
	const blockEnd = editor.api.end(block[1]);
	if (blockEnd) editor.tf.select(blockEnd);
}

function insertCodeBlock(editor: SlateEditor, language?: string): void {
	clearCurrentList(editor);
	const block = editor.api.block();
	if (!block) return;
	toggleCodeBlock(editor);
	if (language) {
		editor.tf.setNodes<TCodeBlockElement>({ lang: language }, { at: block[1] });
	}
}

function insertMermaidCodeBlock(editor: SlateEditor): void {
	clearCurrentList(editor);
	const block = editor.api.block();
	if (!block) return;
	const hasExistingText = editor.api.string(block[1]).trim().length > 0;

	toggleCodeBlock(editor);
	if (hasExistingText) {
		editor.tf.setNodes<TCodeBlockElement>(
			{ lang: "mermaid" },
			{ at: block[1] },
		);
		return;
	}

	const codeLineType = editor.getType(KEYS.codeLine);
	const children = [
		{ type: codeLineType, children: [{ text: "graph LR" }] },
		{ type: codeLineType, children: [{ text: "A[Start] --> B[Process]" }] },
		{ type: codeLineType, children: [{ text: "B --> C[End]" }] },
	];
	editor.tf.replaceNodes(
		{
			type: editor.getType(KEYS.codeBlock),
			lang: "mermaid",
			children,
		},
		{ at: block[1] },
	);

	const lastLinePath = [...block[1], children.length - 1, 0];
	const lastLineOffset = children.at(-1)?.children[0].text.length ?? 0;
	editor.tf.select({
		anchor: { path: lastLinePath, offset: lastLineOffset },
		focus: { path: lastLinePath, offset: lastLineOffset },
	});
}

function insertLinkTemplate(
	editor: SlateEditor,
	kind: EditorLinkTemplateKind,
): void {
	const selection = editor.selection;
	if (!selection) return;
	insertEditorLinkTemplate(editor, kind, selection);
}

function insertObsidianCallout(
	editor: SlateEditor,
	blockPath: number[],
): boolean {
	const entry = editor.api.node(blockPath);
	const block = entry?.[0] as TElement | undefined;
	if (!block || !Array.isArray(block.children)) return false;
	const children = block.children.length ? block.children : [{ text: "" }];
	editor.tf.replaceNodes(
		{
			type: editor.getType(KEYS.callout),
			calloutType: "note",
			calloutTypeRaw: "note",
			children: [
				{
					type: editor.getType(KEYS.p),
					children,
				},
			],
		},
		{ at: blockPath },
	);
	const bodyEnd = editor.api.end([...blockPath, 0]);
	if (bodyEnd) editor.tf.select(bodyEnd);
	return true;
}

/**
 * Consume the live `/query` and apply one Markdown-compatible transformation.
 * The current query is revalidated immediately before mutation so a stale menu
 * cannot delete unrelated text after the selection moves.
 */
export function executeSlashCommand(
	editor: SlateEditor,
	commandId: SlashCommandId,
	target: SlashCommandTarget,
): boolean {
	const live = findLiveSlashCommand(editor, target);
	if (!live) return false;
	if (commandId === "callout" && !canInsertCallout(editor, live.blockPath)) {
		return false;
	}

	consumeSlashCommand(editor, live.trigger);

	switch (commandId) {
		case "heading1":
			applyBlockType(editor, editor.getType(KEYS.h1));
			break;
		case "heading2":
			applyBlockType(editor, editor.getType(KEYS.h2));
			break;
		case "heading3":
			applyBlockType(editor, editor.getType(KEYS.h3));
			break;
		case "bulletedList":
			applyListStyle(editor, ListStyleType.Disc);
			break;
		case "numberedList":
			applyListStyle(editor, ListStyleType.Decimal);
			break;
		case "todoList":
			applyListStyle(editor, KEYS.listTodo);
			break;
		case "quote":
			applyBlockType(editor, editor.getType(KEYS.blockquote));
			break;
		case "codeBlock":
			insertCodeBlock(editor);
			break;
		case "mermaid":
			insertMermaidCodeBlock(editor);
			break;
		case "internalLink":
			insertLinkTemplate(editor, "wiki");
			break;
		case "externalLink":
			insertLinkTemplate(editor, "external");
			break;
		case "callout":
			return insertObsidianCallout(editor, live.blockPath);
	}
	return true;
}
