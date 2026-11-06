import DOMPurify from "dompurify";
import { createElement, memo, type ReactNode, useMemo } from "react";
import { MathText, type MathTextProps } from "@/components/ui/math-text";
import { hasTitleMath, parseTitleMath } from "@/lib/paper/title-math";

const TITLE_MARKUP = /<\/?[a-z][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i;

function renderTitleNode(node: Node, key: number): ReactNode {
	if (node.nodeType === Node.TEXT_NODE) {
		const text = node.textContent ?? "";
		return hasTitleMath(text) ? <MathText key={key} text={text} /> : text;
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return null;
	// DOMPurify has already limited elements to inline typography and removed
	// every attribute. Build React elements instead of injecting source HTML.
	return createElement(
		(node as Element).localName,
		{ key },
		...Array.from(node.childNodes, renderTitleNode),
	);
}

/** Display catalog title markup without changing the stored/copyable source. */
export const PaperTitle = memo(function PaperTitle({
	text,
	className,
	title,
}: MathTextProps) {
	const formatted = useMemo(() => {
		if (!TITLE_MARKUP.test(text)) return null;
		// Protect TeX comparisons and commands from the HTML parser, including
		// formulas nested inside italic/bold title fragments.
		const html = parseTitleMath(text)
			.map((segment) =>
				segment.kind === "text"
					? segment.value
					: `\\(${segment.value
							.replaceAll("&", "&amp;")
							.replaceAll("<", "&lt;")
							.replaceAll(">", "&gt;")}\\)`,
			)
			.join("");
		const fragment = DOMPurify.sanitize(html, {
			ALLOWED_TAGS: ["i", "em", "b", "strong", "sup", "sub", "u", "s", "small"],
			ALLOWED_ATTR: [],
			ALLOW_ARIA_ATTR: false,
			ALLOW_DATA_ATTR: false,
			RETURN_DOM_FRAGMENT: true,
		});
		return {
			content: Array.from(fragment.childNodes, renderTitleNode),
			plainText: fragment.textContent ?? "",
		};
	}, [text]);

	if (!formatted) {
		return <MathText text={text} className={className} title={title} />;
	}
	return (
		<span className={className} title={title ?? formatted.plainText}>
			{formatted.content}
		</span>
	);
});
