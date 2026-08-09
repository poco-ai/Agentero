/**
 * Portable wikilink syntax and Markdown round-trip rules.
 *
 * This module deliberately has no React/component imports so Markdown parsing
 * can be reused by both the primary editor and read-only embed projections
 * without creating a component registration cycle.
 */

/**
 * Strip CommonMark-style escapes (esp. `\_`) that mdast `state.safe` injects
 * when serializing wiki-link targets. Paths like `papers/10_1007_…/NOTES` must
 * not become `papers/10\_1007\_…/NOTES` or resolution falls back to ambiguous
 * stem matches (e.g. many `NOTES`).
 */
export function unescapeWikiLinkText(raw: string): string {
	return raw.replace(/\\(.)/g, "$1");
}

/** mdast node produced by `@flowershow/remark-wiki-link`. */
type MdWikiLink = {
	type: string;
	value?: string;
	data?: {
		alias?: string;
		hProperties?: Record<string, unknown>;
	};
};

export type WikiSlateNode = {
	type: "wikiLink";
	value: string;
	heading?: string | null;
	alias?: string | null;
	embed?: boolean;
	children: { text: string }[];
};

export type WikiLinkDraftText = {
	text: string;
	wikiLinkDraft: true;
};

/**
 * Split a wikilink main body (no alias) into target + fragment suffix.
 * - `#…` → heading / `^block` / `@annotation` (fragment keeps leading ^/@ when present)
 * - sugar `target@id` → heading field `@id` so serialization can prefer sugar form
 */
export function splitWikiLinkTarget(raw: string): {
	target: string;
	heading: string;
} {
	// Unescape the whole body first so path segments with `_` survive a prior
	// serialize that ran through mdast `state.safe` (not only the annotation id).
	const text = unescapeWikiLinkText(raw);
	const h = text.indexOf("#");
	if (h >= 0) {
		return { target: text.slice(0, h), heading: text.slice(h + 1) };
	}
	const at = text.lastIndexOf("@");
	if (at >= 0) {
		const id = text.slice(at + 1).trim();
		// nanoid may include `_`; mirror Host `is_valid_annotation_id`.
		if (id.length > 0 && /^[\p{L}\p{N}_-]+$/u.test(id)) {
			return { target: text.slice(0, at), heading: `@${id}` };
		}
	}
	return { target: text, heading: "" };
}

function findWikiLinkAliasSeparator(raw: string): number {
	for (let index = 0; index < raw.length; index += 1) {
		if (raw[index] !== "|" || raw[index - 1] === "\\") continue;
		return index;
	}
	return -1;
}

/** Convert the structured display node into the portable text a user edits. */
export function wikiLinkToMarkdown(node: {
	value: string;
	heading?: string | null;
	alias?: string | null;
	embed?: boolean;
}): string {
	let target = node.value;
	if (node.heading) {
		// Prefer sugar `target@id`, or same-note `[[@id]]` when value is empty.
		target = node.heading.startsWith("@")
			? node.value
				? `${node.value}${node.heading}`
				: node.heading
			: node.value
				? `${node.value}#${node.heading}`
				: `#${node.heading}`;
	}
	const alias = node.alias ? `|${node.alias.replaceAll("|", "\\|")}` : "";
	return `${node.embed ? "!" : ""}[[${target}${alias}]]`;
}

/**
 * Parse only a complete inline Wikilink. Partial or malformed edit text must
 * remain ordinary Markdown text, so users never lose an in-progress edit.
 */
export function parseWikiLinkMarkdown(raw: string): WikiSlateNode | null {
	const match = raw.match(/^(!?)\[\[([^\]\n]+)\]\]$/);
	if (!match) return null;
	const [, embedMarker, body] = match;
	const pipe = findWikiLinkAliasSeparator(body);
	const targetWithHeading = pipe < 0 ? body : body.slice(0, pipe);
	const aliasText =
		pipe < 0 ? null : unescapeWikiLinkText(body.slice(pipe + 1));
	if (targetWithHeading.endsWith("#") || aliasText === "") return null;
	const { target, heading } = splitWikiLinkTarget(targetWithHeading);
	if (!target && !heading) return null;
	const parsed: Omit<WikiSlateNode, "children"> = {
		type: "wikiLink",
		value: target,
		heading: heading || undefined,
		alias: aliasText,
		embed: embedMarker === "!",
	};
	return {
		...parsed,
		children: [{ text: wikiLinkToMarkdown(parsed) }],
	};
}

export function isWikiLinkDraftText(node: unknown): node is WikiLinkDraftText {
	return (
		typeof node === "object" &&
		node !== null &&
		"text" in node &&
		"wikiLinkDraft" in node &&
		(node as { wikiLinkDraft?: unknown }).wikiLinkDraft === true
	);
}

/** The editable target range, excluding the `[[` / `]]` delimiters. */
export function wikiLinkDraftEditableBounds(raw: string): {
	start: number;
	end: number;
} {
	return {
		start: raw.startsWith("![[") ? 3 : 2,
		end: Math.max(raw.length - 2, 0),
	};
}

/**
 * Source syntax stays visible only while the caret is on one of its characters.
 * Offsets 0 and `raw.length` are outside the source and must project immediately.
 */
export function isWikiLinkDraftEditingOffset(
	raw: string,
	offset: number,
): boolean {
	return offset > 0 && offset < raw.length;
}

export function wikiLinkDraftExteriorPlacement(
	raw: string,
	offset: number,
): "before" | "after" | null {
	if (offset === 0) return "before";
	if (offset === raw.length) return "after";
	return null;
}

export function isWikiLinkNode(node: unknown): node is WikiSlateNode {
	return (
		typeof node === "object" &&
		node !== null &&
		(node as { type?: unknown }).type === "wikiLink" &&
		typeof (node as { value?: unknown }).value === "string"
	);
}

/** Return the editable Markdown source retained by a stable Wikilink node. */
export function wikiLinkNodeSource(node: WikiSlateNode): string {
	return node.children
		.map((child) => (typeof child.text === "string" ? child.text : ""))
		.join("");
}

/** Whether cached navigation attributes already match the editable source. */
export function wikiLinkNodeMatchesSource(
	node: WikiSlateNode,
	parsed: WikiSlateNode,
): boolean {
	return (
		node.value === parsed.value &&
		(node.heading ?? undefined) === (parsed.heading ?? undefined) &&
		(node.alias ?? null) === (parsed.alias ?? null) &&
		(node.embed === true) === (parsed.embed === true)
	);
}

function toSlate(node: MdWikiLink, embed: boolean): WikiSlateNode {
	const raw = node.value ?? "";
	const { target, heading } = splitWikiLinkTarget(raw);
	let alias = node.data?.alias ?? null;
	if (typeof alias === "string") {
		alias = unescapeWikiLinkText(alias);
	}
	if (embed) {
		const width = node.data?.hProperties?.["data-fs-width"];
		const height = node.data?.hProperties?.["data-fs-height"];
		if (width || height) {
			alias = width && height ? `${width}x${height}` : String(width || height);
		}
	}
	const parsed: Omit<WikiSlateNode, "children"> = {
		type: "wikiLink",
		value: target,
		heading: heading || undefined,
		alias,
		embed,
	};
	return {
		...parsed,
		children: [{ text: wikiLinkToMarkdown(parsed) }],
	};
}

/**
 * Build the mdast `value` for a wiki link / embed.
 * Prefer sugar `target@id` for annotations (matches copy-from-panel + Obsidian);
 * other fragments keep `target#fragment`.
 */
function wikiLinkMdastMain(node: {
	value: string;
	heading?: string | null;
}): string {
	if (!node.heading) return node.value;
	if (node.heading.startsWith("@")) {
		return node.value ? `${node.value}${node.heading}` : node.heading;
	}
	return node.value ? `${node.value}#${node.heading}` : `#${node.heading}`;
}

function serializeWikiLinkNode(node: {
	value: string;
	heading?: string | null;
	alias?: string | null;
	embed?: boolean;
}) {
	const value = wikiLinkMdastMain(node);
	const data: { alias?: string } = {};
	if (node.alias) data.alias = node.alias;
	return { type: node.embed ? "embed" : "wikiLink", value, data };
}

/**
 * Emit `[[…]]` / `![[…]]` without mdast `state.safe`.
 *
 * `@flowershow/remark-wiki-link` uses `state.safe` which escapes `_` under
 * Plate's `emphasis: "_"` stringify option. Vault paths with underscores then
 * round-trip incorrectly on save/reopen.
 */
function formatWikiLinkMdastLiteral(
	node: {
		value?: string | null;
		data?: { alias?: string; hProperties?: Record<string, unknown> };
	},
	embed: boolean,
	aliasDivider = "|",
): string {
	const main = unescapeWikiLinkText(String(node.value ?? ""));
	const width = node.data?.hProperties?.["data-fs-width"];
	const height = node.data?.hProperties?.["data-fs-height"];
	let aliasOrDimensions = "";
	if (embed && (width || height)) {
		aliasOrDimensions =
			width && height ? `${width}x${height}` : String(width || height || "");
	} else if (node.data?.alias) {
		aliasOrDimensions = unescapeWikiLinkText(
			String(node.data.alias),
		).replaceAll("|", "\\|");
	}
	const open = embed ? "![[" : "[[";
	return aliasOrDimensions
		? `${open}${main}${aliasDivider}${aliasOrDimensions}]]`
		: `${open}${main}]]`;
}

/** Minimal unified processor surface used by remark plugin setup. */
type RemarkPluginThis = {
	data: () => Record<string, unknown[] | undefined>;
};

/**
 * Remark plugin (after `@flowershow/remark-wiki-link`) that replaces wiki/embed
 * toMarkdown handlers so path underscores are not re-escaped on save.
 */
export function remarkWikiLinkLiteralPaths(this: RemarkPluginThis): void {
	// unified binds `this` to the processor when the plugin is attached.
	const data = this.data();
	const add = (field: string, value: unknown) => {
		const existing = data[field];
		if (existing) existing.push(value);
		else data[field] = [value];
	};
	add("toMarkdownExtensions", {
		handlers: {
			wikiLink: (node: {
				value?: string;
				data?: { alias?: string; hProperties?: Record<string, unknown> };
			}) => formatWikiLinkMdastLiteral(node, false),
			embed: (node: {
				value?: string;
				data?: { alias?: string; hProperties?: Record<string, unknown> };
			}) => formatWikiLinkMdastLiteral(node, true),
		},
	});
}

export const wikiLinkRules = {
	wikiLink: {
		deserialize: (node: MdWikiLink) => toSlate(node, false),
		serialize: (node: WikiSlateNode) => {
			const raw = wikiLinkNodeSource(node) || wikiLinkToMarkdown(node);
			const parsed = parseWikiLinkMarkdown(raw);
			return parsed
				? serializeWikiLinkNode(parsed)
				: { type: "text", value: raw };
		},
	},
	embed: {
		deserialize: (node: MdWikiLink) => toSlate(node, true),
	},
	wikiLinkDraft: {
		mark: true,
		serialize: (node: WikiLinkDraftText) => {
			const parsed = parseWikiLinkMarkdown(node.text);
			return parsed
				? serializeWikiLinkNode(parsed)
				: { type: "text", value: node.text };
		},
	},
};
