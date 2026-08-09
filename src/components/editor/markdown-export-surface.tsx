"use client";

import { MarkdownPlugin } from "@platejs/markdown";
import { ImagePlugin } from "@platejs/media/react";
import { Plate, usePlateEditor } from "platejs/react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Editor } from "@/components/editor/editor";
import { EmbeddedMarkdownProjection } from "@/components/editor/embedded-markdown-projection";
import { ImageElement } from "@/components/editor/image-node";
import { MarkdownDocProvider } from "@/components/editor/markdown-doc-context";
import {
	type MarkdownExportMode,
	MarkdownExportModeProvider,
} from "@/components/editor/markdown-export-mode-context";
import { MarkdownEditorKit } from "@/components/editor/plugins/markdown-editor-kit";
import { WikiEmbedProjectionProvider } from "@/components/editor/wiki-embed-projection-context";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import { splitFrontmatter } from "@/lib/markdown/doc";
import type { MarkdownExportPaperHeader } from "@/lib/markdown/export/types";

export function MarkdownExportSurface({
	markdown,
	filePath,
	expandEmbeds,
	paperHeader,
	watermark,
	onMounted,
}: {
	markdown: string;
	filePath: string | null;
	expandEmbeds: boolean;
	paperHeader: MarkdownExportPaperHeader | null;
	watermark: boolean;
	onMounted: (el: HTMLElement) => void;
}) {
	const { t } = useTranslation("editor");
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const exportMode = useMemo<MarkdownExportMode>(
		() => ({
			expandEmbeds,
			hideChromeActions: true,
		}),
		[expandEmbeds],
	);

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

	useEffect(() => {
		const el = surfaceRef.current;
		if (el) onMounted(el);
	}, [onMounted]);

	return (
		<div
			ref={surfaceRef}
			data-markdown-export-surface=""
			className="bg-background text-foreground"
			style={{ width: 800, boxSizing: "border-box" }}
		>
			<div className="relative px-10 py-8">
				{paperHeader ? (
					<header className="mb-6 border-border border-b pb-4">
						<h1 className="font-semibold text-xl leading-snug tracking-tight">
							{paperHeader.title}
						</h1>
						{(paperHeader.authorsLine || paperHeader.year != null) && (
							<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
								{[
									paperHeader.authorsLine,
									paperHeader.year != null ? String(paperHeader.year) : null,
								]
									.filter(Boolean)
									.join(" · ")}
							</p>
						)}
						{paperHeader.link ? (
							<p className="mt-1.5 text-primary text-sm">
								<a
									href={paperHeader.link}
									className="underline underline-offset-2"
								>
									{paperHeader.linkLabel || paperHeader.link}
								</a>
							</p>
						) : null}
					</header>
				) : null}

				<MarkdownExportModeProvider value={exportMode}>
					<WikiEmbedProjectionProvider component={EmbeddedMarkdownProjection}>
						<MarkdownDocProvider value={{ filePath }}>
							<Plate editor={editor}>
								<Editor
									variant="none"
									readOnly
									className="min-h-0 w-full min-w-0 cursor-default break-words text-base leading-relaxed [&>*:first-child]:mt-0"
								/>
							</Plate>
						</MarkdownDocProvider>
					</WikiEmbedProjectionProvider>
				</MarkdownExportModeProvider>

				{watermark ? (
					<div
						aria-hidden
						className="pointer-events-none absolute right-6 bottom-4 select-none font-medium text-[11px] text-muted-foreground/45 tracking-wide"
					>
						{t("export.watermark")}
					</div>
				) : null}
			</div>
		</div>
	);
}
