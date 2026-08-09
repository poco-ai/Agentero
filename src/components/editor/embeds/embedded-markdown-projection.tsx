"use client";

import { MarkdownPlugin } from "@platejs/markdown";
import { ImagePlugin } from "@platejs/media/react";
import { Plate, usePlateEditor } from "platejs/react";
import { memo, useMemo } from "react";
import { MarkdownDocProvider } from "@/components/editor/context/markdown-doc-context";
import { Editor } from "@/components/editor/editor-surface";
import { WikiEmbedProjectionProvider } from "@/components/editor/embeds/projection-context";
import { ImageElement } from "@/components/editor/nodes/block/image-node";
import { MarkdownEditorKit } from "@/components/editor/plugins/markdown-editor-kit";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";

export const EmbeddedMarkdownProjection = memo(
	function EmbeddedMarkdownProjection({
		markdown,
		filePath,
	}: {
		markdown: string;
		filePath: string;
	}) {
		const plugins = useMemo(
			() => [...MarkdownEditorKit, ImagePlugin.withComponent(ImageElement)],
			[],
		);
		const editor = usePlateEditor({
			plugins,
			value: (currentEditor) => {
				const { body } = splitFrontmatter(markdown);
				return currentEditor
					.getApi(MarkdownPlugin)
					.markdown.deserialize(prepareMarkdownForDeserialize(body || " "));
			},
		});

		return (
			<WikiEmbedProjectionProvider component={EmbeddedMarkdownProjection}>
				<MarkdownDocProvider value={{ filePath }}>
					<Plate editor={editor}>
						<Editor
							readOnly
							className="min-h-0 w-full min-w-0 cursor-default break-words px-4 pt-2 pb-3 text-sm leading-relaxed [&>*:first-child]:mt-0"
						/>
					</Plate>
				</MarkdownDocProvider>
			</WikiEmbedProjectionProvider>
		);
	},
);
