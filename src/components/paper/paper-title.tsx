import DOMPurify from "dompurify";
import parse from "html-react-parser";
import { memo, useMemo } from "react";
import { MathText, type MathTextProps } from "@/components/ui/math-text";
import { hasTitleMath, parseTitleMath } from "@/lib/paper/title-math";

const TITLE_MARKUP = /<\/?[a-z][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/i;

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
		// html-react-parser converts HTML to React; it does not sanitize input.
		const safeHtml = DOMPurify.sanitize(html, {
			ALLOWED_TAGS: ["i", "em", "b", "strong", "sup", "sub", "u", "s", "small"],
			ALLOWED_ATTR: [],
			ALLOW_ARIA_ATTR: false,
			ALLOW_DATA_ATTR: false,
		});
		let plainText = "";
		const content = parse(safeHtml, {
			replace(node) {
				if (node.type !== "text") return;
				plainText += node.data;
				if (hasTitleMath(node.data)) return <MathText text={node.data} />;
			},
		});
		return { content, plainText };
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
