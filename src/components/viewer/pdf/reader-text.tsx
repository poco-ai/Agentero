import type { PdfLinkAnnoObject, Size } from "@embedpdf/models";
import { type ReactNode, useMemo } from "react";
import { textLinkHoverPoint } from "@/components/viewer/pdf/link-hover";

import type { PdfLinkHoverPoint } from "@/components/viewer/pdf/types";

import { linkColorOnPaper } from "@/lib/pdf/layout/link-ink";
import {
	assignPreservedLinks,
	type GlyphRun,
	type TranslateLinkBox,
} from "@/lib/pdf/layout/translated-links";
import {
	linkHoverSuppressed,
	linkPreviewDragActive,
} from "@/lib/pdf/link-preview-drag";
import { linkTargetUrl } from "@/lib/pdf/link-target";
import type { ReadingBlock } from "@/lib/pdf/reading/blocks";
import {
	readingFormulaMetrics,
	readingInlineParts,
} from "@/lib/pdf/reading/inline";

import {
	type ReadingSettings,
	readingColors,
} from "@/lib/pdf/reading/settings";
import type { Formula } from "@/lib/pdf/reflow/types";

export type ReaderLinkHandlers = {
	onLinkActivate?: (link: PdfLinkAnnoObject) => void;
	onLinkHover?: (
		link: PdfLinkAnnoObject | null,
		point?: PdfLinkHoverPoint | null,
	) => void;
	onUrlActivate?: (url: string) => void;
	onUrlHover?: (url: string | null, point?: PdfLinkHoverPoint | null) => void;
};
export type ReaderPageLinks = {
	boxes: readonly TranslateLinkBox[];
	byId: ReadonlyMap<string, PdfLinkAnnoObject>;
	runs?: readonly GlyphRun[];
};

function linkColor(color: string | undefined, settings: ReadingSettings) {
	let theme = settings.theme;
	if (theme === "custom") {
		const { backgroundColor } = readingColors(settings);
		const rgb = [1, 3, 5].map((i) =>
			Number.parseInt(backgroundColor.slice(i, i + 2), 16),
		);
		theme =
			rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 < 128
				? "dark"
				: "original";
	}
	return linkColorOnPaper(
		color ?? "#0000ff",
		theme === "original" ? "white" : theme,
	);
}

/** Reading text uses the PDF's native annotation identities and preview cards. */
export function ReaderText({
	block,
	translated,
	pageSize,
	settings,
	links,
	handlers,
	renderFormula,
}: {
	block: ReadingBlock;
	translated?: boolean;
	pageSize?: Size;
	settings: ReadingSettings;
	links?: ReaderPageLinks;
	handlers: ReaderLinkHandlers;
	renderFormula: (formula: Formula, baselineOffset: number) => ReactNode;
}) {
	const paragraph = block.item?.reflow;
	const protectedText = translated
		? (block.item?.translated ?? block.translated ?? "")
		: block.source;
	const content = useMemo(
		() => readingInlineParts(protectedText, paragraph),
		[protectedText, paragraph],
	);
	const assignments = useMemo(() => {
		// Bare URLs remain clickable without allocating a second glyph model
		// for every unlinked paragraph in a long document.
		if (!links?.boxes.length) return assignPreservedLinks(content.text, []);
		const runs =
			paragraph?.characters.length && pageSize
				? paragraph.characters.map((c) => ({
						text: c.text,
						box: {
							x: c.box.x / pageSize.width,
							y: c.box.y / pageSize.height,
							w: c.box.w / pageSize.width,
							h: c.box.h / pageSize.height,
						},
					}))
				: links?.runs;
		return assignPreservedLinks(content.text, links.boxes, {
			source: readingInlineParts(block.source, paragraph).text,
			block: block.bbox,
			runs,
		});
	}, [content.text, links, block.source, block.bbox, paragraph, pageSize]);
	const linkedText = (start: number, end: number): ReactNode => {
		const nodes: ReactNode[] = [];
		let cursor = start;
		for (const assignment of assignments) {
			const from = Math.max(start, assignment.start),
				to = Math.min(end, assignment.end);
			if (from >= to || from < cursor) continue;
			if (from > cursor) nodes.push(content.text.slice(cursor, from));
			const link = assignment.key ? links?.byId.get(assignment.key) : undefined;
			const url = (link && linkTargetUrl(link.target)) || assignment.url;
			const hover = (point: PdfLinkHoverPoint | null) => {
				if (url) {
					handlers.onLinkHover?.(null);
					handlers.onUrlHover?.(point ? url : null, point);
				} else {
					handlers.onUrlHover?.(null);
					handlers.onLinkHover?.(point ? (link ?? null) : null, point);
				}
			};
			nodes.push(
				<a
					key={`link-${from}`}
					href={url ?? "#"}
					draggable={false}
					data-reader-link={assignment.key ?? assignment.url}
					className="cursor-pointer select-text rounded-sm focus-visible:outline focus-visible:outline-1"
					style={{ color: linkColor(assignment.color, settings) }}
					onDragStart={(e) => e.preventDefault()}
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						if (window.getSelection()?.toString()) return;
						if (link) handlers.onLinkActivate?.(link);
						else if (url) handlers.onUrlActivate?.(url);
					}}
					onPointerEnter={(e) => {
						if (linkHoverSuppressed(e.buttons)) return;
						hover(textLinkHoverPoint(e.currentTarget));
					}}
					onPointerMove={(e) => {
						if (!linkHoverSuppressed(e.buttons))
							hover(textLinkHoverPoint(e.currentTarget));
					}}
					onPointerLeave={() => {
						if (!linkPreviewDragActive()) hover(null);
					}}
					onFocus={(e) => {
						hover(textLinkHoverPoint(e.currentTarget));
					}}
					onBlur={() => hover(null)}
				>
					{content.text.slice(from, to)}
				</a>,
			);
			cursor = to;
		}
		if (cursor < end) nodes.push(content.text.slice(cursor, end));
		return nodes;
	};

	return readingInlineParts(protectedText, paragraph, assignments).parts.map(
		(part) => {
			const formula = part.formula;

			const metrics =
				paragraph && formula
					? readingFormulaMetrics(paragraph, formula, pageSize?.height ?? 0)
					: undefined;
			if (formula && part.raster)
				return (
					<span
						key={part.start}
						data-reader-start={part.start}
						data-reader-end={part.end}
						data-reader-raster
					>
						{renderFormula(
							formula,
							metrics?.baselineOffset ?? formula.baselineOffset,
						)}
					</span>
				);
			const style =
				(formula && metrics?.style) ?? part.style ?? paragraph?.style;
			return (
				<span
					key={part.start}
					data-reader-inline-text={formula ? formula.id : undefined}
					style={{
						fontWeight: style?.bold
							? 700
							: !part.style && block.kind === "header"
								? undefined
								: 400,
						fontStyle: style?.italic ? "italic" : "normal",
						...(formula && metrics
							? {
									fontSize: `${metrics.fontScale}em`,
									position: "relative",
									top: `${-metrics.textRise / (paragraph?.style.size ?? 10) / metrics.fontScale}em`,
									lineHeight: 0,
								}
							: {}),
					}}
				>
					{linkedText(part.start, part.end)}
				</span>
			);
		},
	);
}
