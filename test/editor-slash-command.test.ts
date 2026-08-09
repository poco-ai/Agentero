import { BaseListPlugin } from "@platejs/list";
import { MarkdownPlugin } from "@platejs/markdown";
import {
	createSlateEditor,
	createSlatePlugin,
	KEYS,
	type TElement,
} from "platejs";
import { describe, expect, it } from "vitest";
import { LinkPlugin } from "@/components/editor/plugins/link-plugin";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import {
	executeSlashCommand,
	filterSlashCommands,
	findSlashCommandTrigger,
	isSlashCommandSubmitKey,
	type SlashCommandTarget,
} from "@/lib/markdown/slash-command";

const TestPlugins = [
	KEYS.p,
	KEYS.h1,
	KEYS.h2,
	KEYS.h3,
	KEYS.blockquote,
	KEYS.callout,
	KEYS.codeBlock,
	KEYS.codeLine,
].map((key) =>
	createSlatePlugin({
		key,
		node: { isElement: true },
	}),
);

function createSlashEditor(
	text: string,
	value: TElement[] = [{ type: KEYS.p, children: [{ text }] }],
) {
	const editor = createSlateEditor({
		plugins: [...TestPlugins, BaseListPlugin, LinkPlugin, ...MarkdownKit],
		value,
	});
	const path = value[0]?.type === KEYS.callout ? [0, 0, 0] : [0, 0];
	editor.tf.select({
		anchor: { path, offset: text.length },
		focus: { path, offset: text.length },
	});
	return editor;
}

function currentSlashTarget(
	editor: ReturnType<typeof createSlashEditor>,
): SlashCommandTarget {
	const selection = editor.selection;
	if (!selection) throw new Error("Expected a selected slash command query");
	const path = [...selection.anchor.path];
	const entry = editor.api.node(path);
	const text = (entry?.[0] as { text?: unknown } | undefined)?.text;
	if (typeof text !== "string") {
		throw new Error("Expected the slash command selection to point at text");
	}
	const trigger = findSlashCommandTrigger(text, selection.anchor.offset);
	if (!trigger) throw new Error("Expected a live slash command query");
	return { ...trigger, path };
}

describe("slash command trigger", () => {
	it("matches a slash at the leaf start or after whitespace", () => {
		expect(findSlashCommandTrigger("/", 1)).toEqual({
			query: "",
			start: 0,
			end: 1,
		});
		expect(findSlashCommandTrigger("Intro /h2", 9)).toEqual({
			query: "h2",
			start: 6,
			end: 9,
		});
	});

	it("does not match URLs, escaped slashes, or a query followed by space", () => {
		expect(findSlashCommandTrigger("https://platejs.org", 19)).toBeNull();
		expect(findSlashCommandTrigger("\\/h2", 4)).toBeNull();
		expect(findSlashCommandTrigger("/h2 ", 4)).toBeNull();
	});

	it("does not compete with an active wiki completion draft", () => {
		expect(findSlashCommandTrigger("[[/h2", 5)).toBeNull();
		expect(findSlashCommandTrigger("See [[Target#/h2", 16)).toBeNull();
	});

	it("accepts Enter and Tab as command selection keys", () => {
		expect(isSlashCommandSubmitKey("Enter")).toBe(true);
		expect(isSlashCommandSubmitKey("Tab")).toBe(true);
		expect(isSlashCommandSubmitKey(" ")).toBe(false);
	});

	it("filters localized labels and can hide nested callout insertion", () => {
		const resolveLabel = (command: { labelKey: string }) =>
			({
				"contextMenu.insertWikiLink": "新增双链",
				"contextMenu.insertExternalLink": "新增外部链接",
				"slashCommand.commands.heading1": "一级标题",
				"slashCommand.commands.heading2": "二级标题",
				"slashCommand.commands.heading3": "三级标题",
			})[command.labelKey] ?? command.labelKey;
		expect(
			filterSlashCommands("", resolveLabel).map((command) => command.id),
		).not.toContain("paragraph");
		expect(
			filterSlashCommands("标题", resolveLabel).map((command) => command.id),
		).toEqual(["heading1", "heading2", "heading3"]);
		expect(
			filterSlashCommands("链接", resolveLabel).map((command) => command.id),
		).toEqual(["internalLink", "externalLink"]);
		expect(
			filterSlashCommands("", resolveLabel, { allowCallout: false }).some(
				(command) => command.id === "callout",
			),
		).toBe(false);
	});
});

describe("slash command execution", () => {
	it("revalidates and consumes only the live query before changing the block", () => {
		const editor = createSlashEditor("Intro /h2");

		expect(
			executeSlashCommand(editor, "heading2", currentSlashTarget(editor)),
		).toBe(true);
		expect(editor.children).toMatchObject([
			{ type: KEYS.h2, children: [{ text: "Intro " }] },
		]);

		const stale = createSlashEditor("/h2");
		expect(
			executeSlashCommand(stale, "heading2", {
				...currentSlashTarget(stale),
				query: "h1",
			}),
		).toBe(false);
		expect(stale.children).toMatchObject([
			{ type: KEYS.p, children: [{ text: "/h2" }] },
		]);
	});

	it("rejects a stale target after moving to another identical query", () => {
		const editor = createSlashEditor("/h2", [
			{ type: KEYS.p, children: [{ text: "/h2" }] },
			{ type: KEYS.p, children: [{ text: "/h2" }] },
		]);
		const staleTarget = currentSlashTarget(editor);
		editor.tf.select({
			anchor: { path: [1, 0], offset: 3 },
			focus: { path: [1, 0], offset: 3 },
		});

		expect(executeSlashCommand(editor, "heading2", staleTarget)).toBe(false);
		expect(editor.children).toMatchObject([
			{ type: KEYS.p, children: [{ text: "/h2" }] },
			{ type: KEYS.p, children: [{ text: "/h2" }] },
		]);
	});

	it("creates Markdown-compatible list and code block nodes", () => {
		const list = createSlashEditor("/list");
		expect(
			executeSlashCommand(list, "bulletedList", currentSlashTarget(list)),
		).toBe(true);
		expect(list.children).toMatchObject([
			{ type: KEYS.p, listStyleType: "disc", children: [{ text: "" }] },
		]);

		const todo = createSlashEditor("/todo");
		expect(
			executeSlashCommand(todo, "todoList", currentSlashTarget(todo)),
		).toBe(true);
		expect(todo.children).toMatchObject([
			{
				type: KEYS.p,
				listStyleType: KEYS.listTodo,
				checked: false,
				children: [{ text: "" }],
			},
		]);

		const code = createSlashEditor("/code");
		expect(
			executeSlashCommand(code, "codeBlock", currentSlashTarget(code)),
		).toBe(true);
		expect(code.children).toMatchObject([
			{
				type: KEYS.codeBlock,
				children: [{ type: KEYS.codeLine, children: [{ text: "" }] }],
			},
		]);

		const mermaid = createSlashEditor("/mermaid");
		expect(
			executeSlashCommand(mermaid, "mermaid", currentSlashTarget(mermaid)),
		).toBe(true);
		expect(mermaid.children).toMatchObject([
			{
				type: KEYS.codeBlock,
				lang: "mermaid",
				children: [
					{ type: KEYS.codeLine, children: [{ text: "graph LR" }] },
					{
						type: KEYS.codeLine,
						children: [{ text: "A[Start] --> B[Process]" }],
					},
					{ type: KEYS.codeLine, children: [{ text: "B --> C[End]" }] },
				],
			},
		]);
	});

	it("inserts internal and external links with the context-menu caret behavior", () => {
		const internal = createSlashEditor("Before /internal");
		expect(
			executeSlashCommand(
				internal,
				"internalLink",
				currentSlashTarget(internal),
			),
		).toBe(true);
		expect(internal.api.string([])).toBe("Before [[]]");
		expect(internal.selection).toEqual({
			anchor: { path: [0, 1], offset: 2 },
			focus: { path: [0, 1], offset: 2 },
		});
		expect(internal.api.node([0, 1])?.[0]).toMatchObject({
			text: "[[]]",
			wikiLinkDraft: true,
		});

		const external = createSlashEditor("Before /external");
		expect(
			executeSlashCommand(
				external,
				"externalLink",
				currentSlashTarget(external),
			),
		).toBe(true);
		// External links insert a real `a` node (default placeholder label), not `[]()`.
		const children = (
			external.children[0] as { children: Array<Record<string, unknown>> }
		).children;
		const link = children.find((c) => c.type === KEYS.a);
		expect(link).toMatchObject({
			type: KEYS.a,
			url: "",
		});
		expect(external.api.string([])).toMatch(/^Before .+/);
		expect(JSON.stringify(external.children)).not.toContain("[]()");
	});

	it("clears list metadata when applying a non-list block command", () => {
		const editor = createSlashEditor("/h1", [
			{
				type: KEYS.p,
				indent: 1,
				listStyleType: "disc",
				children: [{ text: "/h1" }],
			},
		]);

		expect(
			executeSlashCommand(editor, "heading1", currentSlashTarget(editor)),
		).toBe(true);
		expect(editor.children).toEqual([
			{ type: KEYS.h1, children: [{ text: "" }] },
		]);
	});

	it("keeps an already selected list style instead of toggling it off", () => {
		const editor = createSlashEditor("/list", [
			{
				type: KEYS.p,
				indent: 1,
				listStyleType: "disc",
				children: [{ text: "/list" }],
			},
		]);

		expect(
			executeSlashCommand(editor, "bulletedList", currentSlashTarget(editor)),
		).toBe(true);
		expect(editor.children).toMatchObject([
			{
				type: KEYS.p,
				indent: 1,
				listStyleType: "disc",
				children: [{ text: "" }],
			},
		]);
	});

	it("keeps an already selected heading or quote block type", () => {
		const heading = createSlashEditor("/h1", [
			{ type: KEYS.h1, children: [{ text: "/h1" }] },
		]);
		expect(
			executeSlashCommand(heading, "heading1", currentSlashTarget(heading)),
		).toBe(true);
		expect(heading.children).toEqual([
			{ type: KEYS.h1, children: [{ text: "" }] },
		]);

		const quote = createSlashEditor("/quote", [
			{ type: KEYS.blockquote, children: [{ text: "/quote" }] },
		]);
		expect(executeSlashCommand(quote, "quote", currentSlashTarget(quote))).toBe(
			true,
		);
		expect(quote.children).toEqual([
			{ type: KEYS.blockquote, children: [{ text: "" }] },
		]);
		expect(quote.selection).toEqual({
			anchor: { path: [0, 0], offset: 0 },
			focus: { path: [0, 0], offset: 0 },
		});
	});

	it("inserts the existing Obsidian callout node and keeps preceding text", () => {
		const editor = createSlashEditor("Remember /callout");

		expect(
			executeSlashCommand(editor, "callout", currentSlashTarget(editor)),
		).toBe(true);
		expect(editor.children).toMatchObject([
			{
				type: KEYS.callout,
				calloutType: "note",
				calloutTypeRaw: "note",
				children: [{ type: KEYS.p, children: [{ text: "Remember " }] }],
			},
		]);
		expect(editor.selection?.anchor.path).toEqual([0, 0, 0]);
		expect(editor.selection?.anchor.offset).toBe("Remember ".length);
		expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toContain(
			"> [!note]",
		);
	});

	it("does not consume a trigger when nested callouts are unsupported", () => {
		const editor = createSlashEditor("/callout", [
			{
				type: KEYS.callout,
				calloutType: "note",
				calloutTypeRaw: "note",
				children: [{ type: KEYS.p, children: [{ text: "/callout" }] }],
			},
		]);

		expect(
			executeSlashCommand(editor, "callout", currentSlashTarget(editor)),
		).toBe(false);
		expect(editor.children).toMatchObject([
			{
				type: KEYS.callout,
				children: [{ type: KEYS.p, children: [{ text: "/callout" }] }],
			},
		]);
	});
});
