import type { TFunction } from "i18next";
import {
	displaySkillName,
	encodeCommandToken,
	encodeMentionToken,
	encodeSelectionToken,
	encodeSkillToken,
	encodeVisualToken,
	type InlineTokenPart,
} from "@/lib/agent/composer-inline-tokens";
import { plazaMentionTitle } from "@/lib/agent/plaza-mention";
import { selectionLineLabel } from "@/lib/agent/selection-line-label";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import { basenameOf } from "@/lib/core/path";
import { cn, truncateToChars } from "@/lib/core/utils";
import { isFeedMentionPath } from "@/lib/plaza/feed-mention";

export const CHIP_ATTR = "data-composer-chip";
const MAX_CHIP_TITLE_CHARS = 9;
const TOKEN_ATTR = "data-composer-token";
/** Zero-width, non-breaking padding after chips so the caret has a landing spot. */
export const CARET_PAD = "\u2060";

const INLINE_CHIP_CLASS =
	"composer-inline-chip mx-0.5 inline-flex max-w-[7rem] shrink-0 items-center gap-0.5 rounded-md border border-border/80 bg-muted/40 px-1 align-middle text-[0.8125em] leading-[1.25] text-foreground hover:bg-muted";

/**
 * Inline reference, not a full-width row. `inline-flex` inside contenteditable
 * is treated as a block and always breaks the line. `inline-block` stays on
 * the caret's line. The default right rail is 320px (~272px of text); a long
 * nowrap quote capped at `100% - 3.5rem` is still wider than the room beside
 * a short prefix, so it wraps every time. Reserving 6rem keeps that prefix
 * and the quote on one line, and a longer prefix wraps the quote as a unit.
 */
const REFERENCE_CHIP_CLASS =
	"composer-inline-chip mx-0.5 inline-block max-w-[min(14rem,calc(100%-6rem))] align-middle overflow-hidden whitespace-nowrap rounded-md border border-primary/30 bg-primary/10 px-1 text-[0.8125em] leading-[1.25] text-foreground hover:bg-primary/20";

const CHIP_ANIMATION_CLASS =
	"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-200 motion-reduce:animate-none";

export function serializeEditor(root: HTMLElement): string {
	let out = "";
	const walk = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			out += (node.textContent ?? "").replaceAll(CARET_PAD, "");
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const el = node as HTMLElement;
		const token = el.getAttribute(TOKEN_ATTR);
		if (token) {
			out += token;
			return;
		}
		const chip = el.getAttribute(CHIP_ATTR);
		if (chip === "mention") {
			const path = el.dataset.path ?? "";
			if (path) out += encodeMentionToken(path);
			return;
		}
		if (chip === "skill") {
			const skillId = el.dataset.skillId ?? "";
			if (skillId) out += encodeSkillToken(skillId);
			return;
		}
		if (chip === "command") {
			const name = el.dataset.commandName ?? "";
			if (name) out += encodeCommandToken(name);
			return;
		}
		if (chip === "selection") {
			const selectionToken = el.dataset.selectionToken ?? "";
			if (selectionToken) out += selectionToken;
			return;
		}
		if (el.tagName === "BR") {
			out += "\n";
			return;
		}
		if (
			(el.tagName === "DIV" || el.tagName === "P") &&
			out.length > 0 &&
			!out.endsWith("\n")
		) {
			out += "\n";
		}
		for (const child of el.childNodes) walk(child);
	};
	for (const child of root.childNodes) walk(child);
	return out;
}

function appendPrefixLabel(
	chip: HTMLElement,
	prefix: string,
	labelText: string,
	title?: string,
) {
	const prefixEl = document.createElement("span");
	prefixEl.className = "font-mono text-muted-foreground";
	prefixEl.textContent = prefix;
	const label = document.createElement("span");
	label.className = "min-w-0 truncate";
	label.textContent = labelText;
	if (title) label.title = title;
	chip.append(prefixEl, label);
}

/** Strip trigger / "skill :" chrome — chip shows the bare skill name. */
export function cleanSkillDisplayName(name: string): string {
	return displaySkillName(name);
}

function appendLucideIcon(
	chip: HTMLElement,
	paths: string[],
	className: string,
) {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("class", className);
	svg.setAttribute("aria-hidden", "true");
	for (const d of paths) {
		const path = document.createElementNS(ns, "path");
		path.setAttribute("d", d);
		svg.appendChild(path);
	}
	chip.appendChild(svg);
}

/** Lucide `sparkles` glyph (skill affordance) for contenteditable chips. */
function appendSkillIcon(chip: HTMLElement) {
	appendLucideIcon(
		chip,
		[
			"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
			"M20 3v4",
			"M22 5h-4",
			"M4 17v2",
			"M5 18H3",
		],
		"size-3 shrink-0 text-muted-foreground",
	);
}

/** Lucide `quote` glyph for an inline selection / block reference. */
function appendQuoteIcon(chip: HTMLElement) {
	appendLucideIcon(
		chip,
		[
			"M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z",
			"M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z",
		],
		"size-3 shrink-0 text-muted-foreground",
	);
}

/** Lucide `image` glyph for an inline visual annotation. */
function appendImageIcon(chip: HTMLElement) {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("class", "size-3 shrink-0 text-muted-foreground");
	svg.setAttribute("aria-hidden", "true");
	const rect = document.createElementNS(ns, "rect");
	rect.setAttribute("width", "18");
	rect.setAttribute("height", "18");
	rect.setAttribute("x", "3");
	rect.setAttribute("y", "3");
	rect.setAttribute("rx", "2");
	const circle = document.createElementNS(ns, "circle");
	circle.setAttribute("cx", "9");
	circle.setAttribute("cy", "9");
	circle.setAttribute("r", "2");
	const path = document.createElementNS(ns, "path");
	path.setAttribute("d", "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21");
	svg.append(rect, circle, path);
	chip.appendChild(svg);
}

function referenceRow(chip: HTMLElement): HTMLElement {
	const row = document.createElement("span");
	row.className = "flex max-w-full items-center gap-0.5";
	chip.appendChild(row);
	return row;
}

function referenceLabel(text: string): HTMLElement {
	const label = document.createElement("span");
	label.dataset.chipLabel = "true";
	label.className = "min-w-0 truncate";
	label.textContent = text;
	return label;
}

function selectionReferenceSnippet(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function appendSkillLabel(chip: HTMLElement, name: string, skillId: string) {
	appendSkillIcon(chip);
	const label = document.createElement("span");
	label.className = "min-w-0 truncate";
	label.textContent = cleanSkillDisplayName(name);
	label.title = skillId;
	chip.appendChild(label);
}

export function placeCaretAtEnd(el: HTMLElement) {
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	let node: Node | null = el.lastChild;
	// selectNodeContents + collapse(false) is unreliable when the editor ends
	// with a contentEditable=false chip: browsers may normalize the caret to
	// before the chip. Walk back to a real text node (caret pad / trailing text)
	// and place the caret at its end.
	while (node && node.nodeType !== Node.TEXT_NODE) {
		node = node.previousSibling;
	}
	if (node) {
		range.setStart(node, (node as Text).data.length);
	} else {
		range.setStart(el, el.childNodes.length);
	}
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

export function placeCaretAfter(node: Node) {
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	range.setStartAfter(node);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

/**
 * Serialized offset of a DOM point. Must agree with `serializeEditor`,
 * including the newline a wrapping div contributes and the caret pad that
 * does not.
 */
export function serializedOffset(
	root: HTMLElement,
	container: Node,
	offset: number,
): number {
	let out = "";
	const append = (value: string) => {
		out += value;
	};
	const writeWhole = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			append((node.textContent ?? "").replaceAll(CARET_PAD, ""));
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const el = node as HTMLElement;
		const token = el.getAttribute(TOKEN_ATTR);
		if (token) {
			append(token);
			return;
		}
		if (el.tagName === "BR") {
			append("\n");
			return;
		}
		if (
			(el.tagName === "DIV" || el.tagName === "P") &&
			out.length > 0 &&
			!out.endsWith("\n")
		) {
			append("\n");
		}
		for (const child of el.childNodes) writeWhole(child);
	};
	const walk = (node: Node): boolean => {
		if (node === container && node.nodeType === Node.TEXT_NODE) {
			const raw = (node as Text).data
				.slice(0, offset)
				.replaceAll(CARET_PAD, "");
			append(raw);
			return true;
		}
		if (node === container && node.nodeType === Node.ELEMENT_NODE) {
			const el = node as HTMLElement;
			const token = el.getAttribute(TOKEN_ATTR);
			if (token) {
				if (offset > 0) append(token);
				return true;
			}
			for (let i = 0; i < offset && i < el.childNodes.length; i++) {
				writeWhole(el.childNodes[i]);
			}
			return true;
		}
		if (node.nodeType === Node.TEXT_NODE) {
			append((node.textContent ?? "").replaceAll(CARET_PAD, ""));
			return false;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return false;
		const el = node as HTMLElement;
		const token = el.getAttribute(TOKEN_ATTR);
		if (token) {
			append(token);
			return false;
		}
		if (el.tagName === "BR") {
			append("\n");
			return false;
		}
		if (
			(el.tagName === "DIV" || el.tagName === "P") &&
			out.length > 0 &&
			!out.endsWith("\n")
		) {
			append("\n");
		}
		for (const child of el.childNodes) {
			if (walk(child)) return true;
		}
		return false;
	};
	if (container === root) {
		for (let i = 0; i < offset && i < root.childNodes.length; i++) {
			writeWhole(root.childNodes[i]);
		}
		return out.length;
	}
	for (const child of root.childNodes) {
		if (walk(child)) break;
	}
	return out.length;
}

/** Place the caret at a serialized offset in the rendered editor. */
export function placeCaretAtSerializedOffset(
	root: HTMLElement,
	target: number,
) {
	let seen = 0;
	const place = (node: Node, offset: number) => {
		const selection = window.getSelection();
		const range = document.createRange();
		range.setStart(node, offset);
		range.collapse(true);
		selection?.removeAllRanges();
		selection?.addRange(range);
	};
	const afterChip = (el: HTMLElement) => {
		const pad = el.nextSibling;
		if (pad && isZwspPad(pad)) placeCaretAfter(pad);
		else placeCaretAfter(el);
	};
	const walk = (node: Node): boolean => {
		if (node.nodeType === Node.TEXT_NODE) {
			const raw = (node as Text).data;
			let serial = 0;
			for (let i = 0; i <= raw.length; i++) {
				if (seen + serial === target) {
					place(node, i);
					return true;
				}
				if (i === raw.length) break;
				if (raw[i] !== CARET_PAD) serial += 1;
			}
			seen += serial;
			return false;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return false;
		const el = node as HTMLElement;
		const token = el.getAttribute(TOKEN_ATTR);
		if (token) {
			if (target <= seen + token.length) {
				afterChip(el);
				return true;
			}
			seen += token.length;
			return false;
		}
		if (el.tagName === "BR") {
			if (target <= seen + 1) {
				placeCaretAfter(el);
				return true;
			}
			seen += 1;
			return false;
		}
		for (const child of el.childNodes) {
			if (walk(child)) return true;
		}
		return false;
	};
	for (const child of root.childNodes) {
		if (walk(child)) return;
	}
	placeCaretAtEnd(root);
}

function isZwspPad(node: Node | null): node is Text {
	return (
		node?.nodeType === Node.TEXT_NODE &&
		(node as Text).data.replaceAll(CARET_PAD, "").length === 0
	);
}

function leadingCaretPadLength(text: Text): number {
	const match = text.data.match(/^\u2060+/);
	return match?.[0].length ?? 0;
}

function findAdjacentTextNode(
	start: Node | null,
	direction: 1 | -1,
): Text | null {
	let node: Node | null = start;
	while (node) {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node as Text;
			if (text.data.replaceAll(CARET_PAD, "").length > 0) {
				return text;
			}
		}
		node = direction === 1 ? node.nextSibling : node.previousSibling;
	}
	return null;
}

export function deleteChipElement(
	chip: HTMLElement,
	pads: Node[] = [],
	direction: "before" | "after" = "before",
) {
	const parent = chip.parentNode;
	if (!parent) return;

	// Decide the caret landing spot before we mutate the DOM.
	const previousText = findAdjacentTextNode(chip.previousSibling, -1);
	const nextText = findAdjacentTextNode(chip.nextSibling, 1);
	const landingText =
		direction === "before"
			? (previousText ?? nextText)
			: (nextText ?? previousText);
	// Backspace normally lands at the end of the previous text; Delete lands at
	// the start of the next text. If one side is absent, use the available side.
	let landingOffset =
		landingText === previousText ? (landingText?.data.length ?? 0) : 0;

	// Collect any caret pads touching the chip so they don't become
	// invisible traps that need a second Backspace/Delete.
	const adjacentPads: Node[] = [];
	let prev = chip.previousSibling;
	while (isZwspPad(prev)) {
		adjacentPads.push(prev);
		prev = prev.previousSibling;
	}
	let next = chip.nextSibling;
	while (isZwspPad(next)) {
		adjacentPads.push(next);
		next = next.nextSibling;
	}

	for (const pad of pads) pad.parentNode?.removeChild(pad);
	for (const pad of adjacentPads) pad.parentNode?.removeChild(pad);
	// Chromium/WebView may merge the caret pad after a chip into the following
	// text node. Remove only that prefix so the visible text stays intact.
	if (landingText) {
		const leadingPadLength = leadingCaretPadLength(landingText);
		if (leadingPadLength > 0) {
			landingText.deleteData(0, leadingPadLength);
			landingOffset = Math.min(landingOffset, landingText.data.length);
		}
	}
	chip.remove();

	const selection = window.getSelection();
	const range = document.createRange();
	if (landingText) {
		range.setStart(landingText, landingOffset);
	} else {
		range.setStart(parent, 0);
	}
	range.collapse(true);
	selection?.removeAllRanges();
	selection?.addRange(range);
}

function isChip(node: Node): node is HTMLElement {
	return (
		node.nodeType === Node.ELEMENT_NODE &&
		(node as HTMLElement).getAttribute(CHIP_ATTR) !== null
	);
}

export function findChipBefore(
	root: HTMLElement,
	range: Range,
): { chip: HTMLElement; pads: Node[] } | null {
	const node = range.startContainer;
	const offset = range.startOffset;
	const pads: Node[] = [];
	let target: Node | null = null;

	// Caret landed inside a chip (e.g. user clicked the chip label): Backspace
	// should delete the whole chip, not move the caret around it.
	if (node.nodeType === Node.ELEMENT_NODE) {
		const chipEl = (node as HTMLElement).closest?.(
			`[${CHIP_ATTR}]`,
		) as HTMLElement | null;
		if (chipEl && root.contains(chipEl)) {
			return { chip: chipEl, pads: [] };
		}
	}

	if (node === root) {
		if (offset === 0) return null;
		target = root.childNodes[offset - 1];
	} else if (node.nodeType === Node.TEXT_NODE) {
		const text = node as Text;
		if (offset === 0) {
			// Caret at the start of a real text node: the chip could be right before it.
			target = text.previousSibling;
		} else if (offset <= leadingCaretPadLength(text)) {
			// The browser can merge the chip's caret pad into the following text
			// node; the caret immediately after that prefix is still next to the chip.
			target = text.previousSibling;
		} else if (offset === text.data.length && text.data.trim().length === 0) {
			// Caret inside a whitespace-only pad: treat it as a pad and look further back.
			pads.unshift(text);
			target = text.previousSibling;
		} else {
			return null;
		}
	} else {
		return null;
	}

	// Skip whitespace/caret pads between the caret and the chip.
	while (
		target?.nodeType === Node.TEXT_NODE &&
		((target as Text).data.replaceAll(CARET_PAD, "").length === 0 ||
			(target as Text).data.trim().length === 0)
	) {
		pads.unshift(target);
		target = target.previousSibling;
	}

	return target && isChip(target) ? { chip: target, pads } : null;
}

export function findChipAfter(
	root: HTMLElement,
	range: Range,
): { chip: HTMLElement; pads: Node[] } | null {
	const node = range.startContainer;
	const offset = range.startOffset;
	const pads: Node[] = [];
	let target: Node | null = null;

	// Caret landed inside a chip (e.g. user clicked the chip label): Delete
	// should delete the whole chip, not move the caret around it.
	if (node.nodeType === Node.ELEMENT_NODE) {
		const chipEl = (node as HTMLElement).closest?.(
			`[${CHIP_ATTR}]`,
		) as HTMLElement | null;
		if (chipEl && root.contains(chipEl)) {
			return { chip: chipEl, pads: [] };
		}
	}

	if (node === root) {
		if (offset >= root.childNodes.length) return null;
		target = root.childNodes[offset];
	} else if (node.nodeType === Node.TEXT_NODE) {
		const text = node as Text;
		if (offset === text.data.length) {
			// Caret at the end of a real text node: the chip could be right after it.
			target = text.nextSibling;
		} else if (offset === 0 && text.data.trim().length === 0) {
			// Caret inside a whitespace-only pad: treat it as a pad and look further ahead.
			pads.push(text);
			target = text.nextSibling;
		} else {
			return null;
		}
	} else {
		return null;
	}

	// Skip whitespace/caret pads between the caret and the chip.
	while (
		target?.nodeType === Node.TEXT_NODE &&
		((target as Text).data.replaceAll(CARET_PAD, "").length === 0 ||
			(target as Text).data.trim().length === 0)
	) {
		pads.push(target);
		target = target.nextSibling;
	}

	return target && isChip(target) ? { chip: target, pads } : null;
}

export function chipToken(part: InlineTokenPart): string {
	switch (part.type) {
		case "mention":
			return encodeMentionToken(part.path);
		case "skill":
			return encodeSkillToken(part.skillId);
		case "command":
			return encodeCommandToken(part.name);
		case "selection":
			return encodeSelectionToken(part.selection);
		case "visual":
			return encodeVisualToken(part.id);
		default:
			return "";
	}
}

export function visualReferenceSnippet(
	draft: PdfVisualDraft | undefined,
	fallback: string,
): string {
	const comment = draft?.comment.replace(/\s+/g, " ").trim() ?? "";
	return comment || fallback;
}

export function renderChip(
	part: InlineTokenPart,
	{
		labelForPath,
		skillLabel,
		visualDrafts,
		t,
		isNew,
	}: {
		labelForPath: (path: string) => string;
		skillLabel: (skillId: string) => string;
		visualDrafts: readonly PdfVisualDraft[];
		t: TFunction<"agent", undefined>;
		isNew?: boolean;
	},
): HTMLElement {
	const chip = document.createElement("span");
	chip.contentEditable = "false";
	const isReference = part.type === "selection" || part.type === "visual";
	chip.className = cn(
		isReference ? REFERENCE_CHIP_CLASS : INLINE_CHIP_CLASS,
		isNew ? CHIP_ANIMATION_CLASS : undefined,
	);

	if (part.type === "mention") {
		chip.setAttribute(CHIP_ATTR, "mention");
		chip.dataset.path = part.path;
		// Plaza mentions show the paper title; vault paths keep the basename.
		const plazaTitle = plazaMentionTitle(part.path);
		const short = plazaTitle
			? truncateToChars(plazaTitle, MAX_CHIP_TITLE_CHARS)
			: basenameOf(part.path) || labelForPath(part.path) || part.path;
		const feedReference = isFeedMentionPath(part.path);
		// Feed references open their detail and own a hover card; the native
		// path tooltip would sit on top of it.
		appendPrefixLabel(chip, "@", short, feedReference ? undefined : part.path);
		chip.setAttribute(
			"aria-label",
			feedReference
				? t("composer.openPlazaEntry", { title: short })
				: t("composer.removeContext", { path: part.path }),
		);
		chip.setAttribute(TOKEN_ATTR, encodeMentionToken(part.path));
	} else if (part.type === "skill") {
		chip.setAttribute(CHIP_ATTR, "skill");
		chip.dataset.skillId = part.skillId;
		const name = skillLabel(part.skillId);
		appendSkillLabel(chip, name, part.skillId);
		chip.setAttribute(
			"aria-label",
			t("composer.removeSkill", {
				skill: cleanSkillDisplayName(name),
			}),
		);
		chip.setAttribute(TOKEN_ATTR, encodeSkillToken(part.skillId));
	} else if (part.type === "command") {
		chip.setAttribute(CHIP_ATTR, "command");
		chip.dataset.commandName = part.name;
		const commandLabel = cleanSkillDisplayName(part.name);
		appendPrefixLabel(chip, "/", commandLabel);
		chip.setAttribute("aria-label", `/${commandLabel}`);
		chip.setAttribute(TOKEN_ATTR, encodeCommandToken(part.name));
	} else if (part.type === "selection") {
		chip.setAttribute(CHIP_ATTR, "selection");
		const { selection } = part;
		const token = encodeSelectionToken(selection);
		chip.dataset.selectionToken = token;
		chip.dataset.selectionId = selection.id;
		chip.setAttribute(TOKEN_ATTR, token);

		const name =
			basenameOf(selection.sourcePath) ||
			labelForPath(selection.sourcePath) ||
			t("composer.selection");
		const source =
			(selection.page
				? t("composer.selectionChipWithPage", {
						title: name,
						page: selection.page,
					})
				: null) ??
			selectionLineLabel(t, selection, name) ??
			name;
		const snippet = selectionReferenceSnippet(selection.text) || source;
		const row = referenceRow(chip);
		appendQuoteIcon(row);
		row.appendChild(referenceLabel(snippet));
		chip.setAttribute("aria-label", snippet);
	} else if (part.type === "visual") {
		chip.setAttribute(CHIP_ATTR, "visual");
		const token = encodeVisualToken(part.id);
		chip.dataset.visualId = part.id;
		chip.setAttribute(TOKEN_ATTR, token);
		const draft = visualDrafts.find((item) => item.id === part.id);
		const pageLabel = t("composer.visualAnnotationPage", {
			page: draft?.page ?? 1,
		});
		const snippet = visualReferenceSnippet(draft, pageLabel);
		const row = referenceRow(chip);
		appendImageIcon(row);
		row.appendChild(referenceLabel(snippet));
		chip.setAttribute("aria-label", snippet);
	}

	return chip;
}
