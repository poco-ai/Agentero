import { MarkdownPlugin } from "@platejs/markdown";
import type { SlateEditor } from "platejs";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import {
	markdownNeedsMdx,
	selectMarkdownRemarkPluginsForDeserialize,
} from "@/lib/markdown/remark-plugins";

/**
 * Deserialize a Markdown body with only the remark plugins that body needs.
 *
 * Centralizes the `prepareMarkdownForDeserialize` + plugin-selection pair so
 * every editor surface (live editor, embeds, export, paste, external reload)
 * parses through the same trimmed pipeline. When the document has no `<` tag,
 * `withoutMdx` also skips Plate's `htmlToJsx` scan of the whole source.
 */
export function deserializeMarkdownBody(
	editor: SlateEditor,
	body: string,
	{ throwOnError = false } = {},
) {
	const prepared = prepareMarkdownForDeserialize(body || " ");
	const remarkPlugins = selectMarkdownRemarkPluginsForDeserialize(prepared);
	const withoutMdx = !markdownNeedsMdx(prepared);
	let mdxError: unknown = null;
	const value = editor.getApi(MarkdownPlugin).markdown.deserialize(prepared, {
		remarkPlugins,
		withoutMdx,
		onError: (error) => {
			if (throwOnError) throw error;
			mdxError = error;
		},
	});
	if (!mdxError || withoutMdx) return value;

	// An unexpected MDX parse error drops us into Plate's
	// `markdownToSlateNodesSafely` recovery, which cuts the source at the first
	// `<name`-looking slice (it cannot tell math/code from JSX) and flattens the
	// whole tail into one inline block: most of the note silently disappears.
	// Re-parse without MDX so every block survives; supported HTML then degrades
	// to literal text instead of vanishing.
	logger.warn("markdown deserialize mdx failed; retrying without mdx", {
		chars: prepared.length,
		error: errorText(mdxError),
	});
	return editor.getApi(MarkdownPlugin).markdown.deserialize(prepared, {
		remarkPlugins,
		withoutMdx: true,
	});
}
