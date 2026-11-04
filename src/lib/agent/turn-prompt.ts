/**
 * Pure assembly of an Agent turn prompt from composer inputs: context path /
 * selection / visual-annotation blocks, the final prompt string, merged image
 * payload, chat visual annotations, and the history title fallback.
 * No side effects — the send pipeline keeps session/ref mutation.
 */
import type { TFunction } from "i18next";
import {
	annotationAppendix,
	planAnnotationRefs,
	proseWithAnnotationMarkers,
	visualDraftsInAnnotationOrder,
} from "@/lib/agent/annotation-prompt";
import type { PromptImage } from "@/lib/agent/api";
import type { ChatVisualAnnotation } from "@/lib/agent/chat-state";
import {
	hasTranscriptChips,
	inlineMarkupToPlain,
	stripInlineTokens,
} from "@/lib/agent/composer-inline-tokens";
import {
	plazaMentionPromptBlock,
	splitContextPaths,
} from "@/lib/agent/plaza-mention";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import type { PaperMetadata } from "@/lib/paper";
import { buildVisualAnnotationsPrompt } from "@/lib/pdf/agent-trace/prompt";

export type AssembleTurnPromptInput = {
	text: string;
	contextPaths: string[];
	visualDrafts: PdfVisualDraft[];
	attachedImages: PromptImage[];
	isAcpCommand: boolean;
	/** Mention path → scratch full-text markdown path (plaza entries). */
	plazaScratchByPath?: ReadonlyMap<string, string> | null;
	/**
	 * Current paper metadata for agents that cannot read Vault files (chat-only
	 * built-ins such as the Zhihu agent). Only public catalog fields are sent —
	 * never a local path. Omitted for ACP agents, which read the paper directly.
	 */
	paper?: PaperMetadata | null;
	t: TFunction<"agent", undefined>;
};

/**
 * Compact, non-sensitive paper block for chat-only agents. Mirrors the fields
 * the Zhihu open platform needs (title / authors / venue / identifiers /
 * abstract); the abstract is capped so the prompt stays bounded.
 */
export function paperContextBlock(
	paper: PaperMetadata,
	t: TFunction<"agent", undefined>,
): string {
	const lines: string[] = [];
	const title = paper.title?.trim();
	if (title) lines.push(`${t("composer.paperContext.title")}: ${title}`);
	const authors = (paper.authors ?? []).map((a) => a.trim()).filter(Boolean);
	if (authors.length) {
		lines.push(`${t("composer.paperContext.authors")}: ${authors.join(", ")}`);
	}
	const venue = paper.publication?.trim();
	if (venue && paper.year) {
		lines.push(`${t("composer.paperContext.venue")}: ${venue} (${paper.year})`);
	} else if (venue) {
		lines.push(`${t("composer.paperContext.venue")}: ${venue}`);
	} else if (paper.year) {
		lines.push(`${t("composer.paperContext.year")}: ${paper.year}`);
	}
	if (paper.arxiv_id?.trim()) lines.push(`arXiv: ${paper.arxiv_id.trim()}`);
	if (paper.doi?.trim()) lines.push(`DOI: ${paper.doi.trim()}`);
	const abstract = paper.abstract?.trim();
	if (abstract) {
		lines.push(
			`${t("composer.paperContext.abstract")}: ${abstract.slice(0, 1200)}`,
		);
	}
	if (lines.length === 0) return "";
	return `${t("composer.paperContext.heading")}\n${lines.join("\n")}`;
}

export type AssembledTurnPrompt = {
	prompt: string;
	images: PromptImage[] | undefined;
	visualAnnotations: ChatVisualAnnotation[] | undefined;
	historyTitle: string;
};

export function assembleTurnPrompt({
	text,
	contextPaths,
	visualDrafts,
	attachedImages,
	isAcpCommand,
	plazaScratchByPath,
	paper,
	t,
}: AssembleTurnPromptInput): AssembledTurnPrompt {
	const displayText = stripInlineTokens(text).trim();
	const annotationRefs = planAnnotationRefs(text);
	const prose =
		annotationRefs.length > 0 ? proseWithAnnotationMarkers(text) : displayText;
	const draftsById = new Map(visualDrafts.map((draft) => [draft.id, draft]));
	const orderedVisualDrafts =
		annotationRefs.length > 0
			? visualDraftsInAnnotationOrder(annotationRefs, visualDrafts)
			: visualDrafts;
	const hasVisualDrafts = orderedVisualDrafts.length > 0;
	const hasAttachedImages = attachedImages.length > 0;

	const contextBlocks: string[] = [];
	// Chat-only agents cannot read Vault files, so the current paper is injected
	// as public metadata (no local path) instead of a read-instruction.
	if (paper && !isAcpCommand) {
		const block = paperContextBlock(paper, t);
		if (block) contextBlocks.push(block);
	}
	// Plaza mentions are virtual paths with no file for the agent to read —
	// expand their metadata inline instead of the vault read-instruction list.
	const { plazaPaths } = splitContextPaths(contextPaths);
	if (plazaPaths.length) {
		contextBlocks.push(
			plazaMentionPromptBlock({
				plazaPaths,
				scratchByPath: plazaScratchByPath,
				t,
			}),
		);
	}
	if (annotationRefs.length > 0) {
		const appendix = annotationAppendix(
			annotationRefs,
			draftsById,
			hasAttachedImages,
		);
		if (appendix) contextBlocks.push(appendix);
	}
	if (annotationRefs.length === 0 && hasVisualDrafts && !isAcpCommand) {
		contextBlocks.push(
			buildVisualAnnotationsPrompt(
				orderedVisualDrafts.map((draft) => ({
					page: draft.page,
					comment: draft.comment,
				})),
			),
		);
	}

	const promptBodyParts: string[] = [];
	if (prose) promptBodyParts.push(prose);
	if (!isAcpCommand && contextBlocks.length) {
		promptBodyParts.push(...contextBlocks);
	}
	const prompt =
		isAcpCommand && displayText
			? displayText
			: promptBodyParts.join("\n\n") ||
				(hasVisualDrafts
					? buildVisualAnnotationsPrompt(
							orderedVisualDrafts.map((draft) => ({
								page: draft.page,
								comment: draft.comment,
							})),
						)
					: hasAttachedImages
						? t("composer.imageOnlyPrompt", {
								count: attachedImages.length,
							})
						: "");

	const visualImages = hasVisualDrafts
		? orderedVisualDrafts.map((draft) => draft.image)
		: [];
	const images =
		visualImages.length || attachedImages.length
			? [...visualImages, ...attachedImages]
			: undefined;

	const visualAnnotations = hasVisualDrafts
		? orderedVisualDrafts.map((draft) => ({
				id: draft.id,
				page: draft.page,
				comment: draft.comment,
				paperPath: draft.paperPath,
				image: {
					data: draft.image.data,
					mimeType: draft.image.mimeType || "image/png",
				},
			}))
		: undefined;

	const historyTitle =
		displayText ||
		(hasTranscriptChips(text) ? inlineMarkupToPlain(text) : "") ||
		orderedVisualDrafts.find((d) => d.comment.trim())?.comment.trim() ||
		(hasVisualDrafts
			? t("composer.visualAnnotationsTitle", {
					count: orderedVisualDrafts.length,
				})
			: hasAttachedImages
				? t("composer.attachedImagesTitle", {
						count: attachedImages.length,
					})
				: t("composer.visualAnnotation"));

	return { prompt, images, visualAnnotations, historyTitle };
}
