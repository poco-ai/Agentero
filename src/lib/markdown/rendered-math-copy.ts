import {
	RENDERED_MATH_SELECTOR,
	renderedMathSource,
} from "@/lib/markdown/rendered-math";

/** Temporary marker copied into the selection fragment to preserve display mode. */
const COPY_DISPLAY_ATTR = "data-agentero-copy-display";

/** Elements whose text content contributes a line break when copying. */
const BLOCK_TAGS = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BLOCKQUOTE",
	"DD",
	"DIV",
	"DL",
	"DT",
	"FIGCAPTION",
	"FIGURE",
	"FOOTER",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"HR",
	"LI",
	"MAIN",
	"NAV",
	"OL",
	"P",
	"PRE",
	"SECTION",
	"TABLE",
	"TBODY",
	"TD",
	"TFOOT",
	"TH",
	"THEAD",
	"TR",
	"UL",
]);

function isDisplayMath(node: Element): boolean {
	return (
		node.classList.contains("katex-display") ||
		Boolean(node.closest(".katex-display")) ||
		node.getAttribute(COPY_DISPLAY_ATTR) === "1"
	);
}

function appendPlainText(node: Node, out: string[]): void {
	if (node.nodeType === Node.TEXT_NODE) {
		out.push(node.textContent ?? "");
		return;
	}
	if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
		for (const child of Array.from(node.childNodes)) {
			appendPlainText(child, out);
		}
		return;
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return;
	const element = node as Element;
	if (element.tagName === "BR") {
		out.push("\n");
		return;
	}
	const block = BLOCK_TAGS.has(element.tagName);
	if (block) out.push("\n");
	for (const child of Array.from(element.childNodes)) {
		appendPlainText(child, out);
	}
	if (block) out.push("\n");
}

/**
 * A selection can start or end *inside* a KaTeX node (common when the user
 * drags over a display formula). Clone the whole equation instead of the
 * partial glyph spans: expand the range edges that sit inside a `.katex`.
 *
 * Returns the expanded range plus the original (document) KaTeX nodes that
 * intersect it — display mode has to be read from the originals because a
 * partial clone may not include the `.katex-display` ancestor.
 */
function expandRangeToMath(
	range: Range,
	doc: Document,
): { range: Range; hits: Element[] } {
	const expanded = range.cloneRange();
	const hits = Array.from(doc.querySelectorAll(RENDERED_MATH_SELECTOR)).filter(
		(katex) => range.intersectsNode(katex),
	);
	for (const katex of hits) {
		if (katex.contains(expanded.startContainer)) {
			expanded.setStartBefore(katex);
		}
		if (katex.contains(expanded.endContainer)) {
			expanded.setEndAfter(katex);
		}
	}
	return { range: expanded, hits };
}

/**
 * Plain text for a DOM selection, with rendered KaTeX nodes replaced by their
 * `$…$` / `$$…$$` Markdown source.
 *
 * Rendered formulas are HTML (KaTeX html + MathML + annotation); the browser's
 * default `text/plain` copy concatenates their glyphs (and often duplicates
 * html/mathml), losing the TeX. AI chat replies render Markdown through
 * Streamdown, which is not a Slate editor, so the editor clipboard path cannot
 * help there.
 *
 * Returns null when the selection contains no rendered math — callers keep the
 * browser's default copy for plain text.
 */
export function renderedMathClipboardText(
	range: Range | null,
	doc: Document = document,
): string | null {
	if (!range || range.collapsed) return null;
	const expanded = expandRangeToMath(range, doc);
	// Mark display mode on the originals so the cloned fragment keeps it even
	// when the `.katex-display` ancestor is not part of the selection.
	for (const katex of expanded.hits) {
		katex.setAttribute(COPY_DISPLAY_ATTR, isDisplayMath(katex) ? "1" : "0");
	}
	let fragment: DocumentFragment;
	try {
		fragment = expanded.range.cloneContents();
	} finally {
		for (const katex of expanded.hits) katex.removeAttribute(COPY_DISPLAY_ATTR);
	}
	const katexNodes = Array.from(
		fragment.querySelectorAll(RENDERED_MATH_SELECTOR),
	);
	if (katexNodes.length === 0) return null;

	let replaced = 0;
	for (const katex of katexNodes) {
		const tex = renderedMathSource(katex);
		if (!tex) continue;
		const replacement = isDisplayMath(katex)
			? `\n$$\n${tex}\n$$\n`
			: `$${tex}$`;
		katex.replaceWith(doc.createTextNode(replacement));
		replaced += 1;
	}
	if (replaced === 0) return null;

	const parts: string[] = [];
	appendPlainText(fragment, parts);
	const text = parts
		.join("")
		.replaceAll("\u00a0", " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text ? text : null;
}

/** Selection range when it starts inside a `[data-markdown-copy]` surface. */
function markedSelectionRange(): Range | null {
	if (typeof document === "undefined") return null;
	const selection = document.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return null;
	}
	const range = selection.getRangeAt(0);
	const container = range.commonAncestorContainer;
	const element =
		container.nodeType === Node.ELEMENT_NODE
			? (container as Element)
			: container.parentElement;
	if (!element?.closest("[data-markdown-copy]")) return null;
	return range;
}

let installed = false;

/**
 * Install a document-level capture listener so copying a text selection inside
 * any `[data-markdown-copy]` rendered-Markdown surface keeps formulas as
 * Markdown source. Idempotent; callers mount it once from `MessageContent`.
 */
export function installRenderedMathCopy(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	document.addEventListener(
		"copy",
		(event) => {
			const clipboardEvent = event as ClipboardEvent;
			if (clipboardEvent.defaultPrevented) return;
			const text = renderedMathClipboardText(markedSelectionRange());
			if (!text) return;
			event.preventDefault();
			event.stopPropagation();
			clipboardEvent.clipboardData?.setData("text/plain", text);
		},
		true,
	);
}
