import { copyTextToClipboard } from "@/lib/core/clipboard";

/** KaTeX keeps the original TeX source in this hidden annotation node. */
const KATEX_SELECTOR = ".katex";
const KATEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';
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

export function katexTexFromNode(node: Element): string | null {
	const annotation = node.querySelector(KATEX_ANNOTATION);
	const tex = annotation?.textContent;
	return tex?.trim() ? tex : null;
}

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
	if (
		element.hasAttribute("data-math-copy-ui") ||
		element.hasAttribute("data-slate-zero-width")
	)
		return;
	if (element.tagName === "BR") {
		out.push("\n");
		return;
	}
	const block =
		BLOCK_TAGS.has(element.tagName) &&
		!element.hasAttribute("data-slate-inline");
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
	const hits = Array.from(doc.querySelectorAll(KATEX_SELECTOR)).filter(
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
	const katexNodes = Array.from(fragment.querySelectorAll(KATEX_SELECTOR));
	if (katexNodes.length === 0) return null;

	let replaced = 0;
	for (const katex of katexNodes) {
		const tex = katexTexFromNode(katex)?.trim();
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

function installMathClickCopy(doc: Document): void {
	let pointer: { id: number; x: number; y: number; moved: boolean } | null =
		null;
	doc.addEventListener(
		"pointerdown",
		(event) => {
			pointer = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				moved: false,
			};
		},
		true,
	);
	doc.addEventListener(
		"pointermove",
		(event) => {
			if (
				pointer &&
				pointer.id === event.pointerId &&
				Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5
			) {
				pointer.moved = true;
			}
		},
		true,
	);
	const cancel = () => {
		if (pointer) pointer.moved = true;
	};
	doc.addEventListener("pointercancel", cancel, true);
	doc.addEventListener("dragstart", cancel, true);
	doc.addEventListener("scroll", cancel, true);
	const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
	doc.addEventListener("click", async (event) => {
		const dragged = pointer?.moved;
		pointer = null;
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			(event.detail > 0 && dragged)
		)
			return;
		const target = event.target instanceof Element ? event.target : null;
		const wrapper = target?.closest<HTMLElement>("[data-math-copy]");
		if (!target || !wrapper) return;
		const button = target.closest("[data-math-copy-button]");
		if (
			!button &&
			(!doc.getSelection()?.isCollapsed || !target.closest(KATEX_SELECTOR))
		)
			return;
		const tex = wrapper.dataset.mathCopyTex ?? katexTexFromNode(wrapper);
		if (!tex?.trim()) return;
		const copied = await copyTextToClipboard(tex, {
			errorMessage: wrapper.dataset.mathCopyError,
		});
		if (!copied || !wrapper.isConnected) return;
		clearTimeout(timers.get(wrapper));
		wrapper.setAttribute("data-math-copied", "");
		const status = wrapper.querySelector("[data-math-copy-status]");
		if (status) status.textContent = wrapper.dataset.mathCopySuccess ?? "";
		timers.set(
			wrapper,
			setTimeout(() => {
				wrapper.removeAttribute("data-math-copied");
				if (status) status.textContent = "";
			}, 1200),
		);
	});
}

/**
 * Delegate formula clicks and preserve Markdown when copying selections inside
 * `[data-markdown-copy]` surfaces. Idempotent across messages and math controls.
 */
export function installRenderedMathCopy(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	installMathClickCopy(document);
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
