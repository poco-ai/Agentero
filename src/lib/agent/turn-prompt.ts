/**
 * Pure assembly of an Agent turn prompt from composer inputs: context path /
 * selection / visual-annotation blocks, the final prompt string, merged image
 * payload, chat visual annotations, and the history title fallback.
 * No side effects — the send pipeline keeps session/ref mutation.
 */
import type { TFunction } from "i18next";
import type { PromptImage } from "@/lib/agent/api";
import type { ChatVisualAnnotation } from "@/lib/agent/chat-state";
import {
	plazaMentionPromptBlock,
	splitContextPaths,
} from "@/lib/agent/plaza-mention";
import { selectionsPromptBlock } from "@/lib/agent/selection-prompt";
import type { SelectionContext } from "@/lib/agent/selection-store";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import { buildVisualAnnotationsPrompt } from "@/lib/pdf/agent-trace/prompt";

export type AssembleTurnPromptInput = {
	text: string;
	contextPaths: string[];
	selections: SelectionContext[];
	visualDrafts: PdfVisualDraft[];
	attachedImages: PromptImage[];
	isAcpCommand: boolean;
	t: TFunction<"agent", undefined>;
};

export type AssembledTurnPrompt = {
	prompt: string;
	images: PromptImage[] | undefined;
	visualAnnotations: ChatVisualAnnotation[] | undefined;
	historyTitle: string;
};

export function assembleTurnPrompt({
	text,
	contextPaths,
	selections,
	visualDrafts,
	attachedImages,
	isAcpCommand,
	t,
}: AssembleTurnPromptInput): AssembledTurnPrompt {
	const hasVisualDrafts = visualDrafts.length > 0;
	const hasAttachedImages = attachedImages.length > 0;

	const contextBlocks: string[] = [];
	// Plaza mentions are virtual paths with no file for the agent to read —
	// expand their metadata inline instead of the vault read-instruction list.
	const { vaultPaths, plazaPaths } = splitContextPaths(contextPaths);
	if (vaultPaths.length) {
		contextBlocks.push(
			`${t("composer.contextInstruction")}\n${vaultPaths
				.map((path) => `- ${path}`)
				.join("\n")}`,
		);
	}
	if (plazaPaths.length) {
		contextBlocks.push(plazaMentionPromptBlock({ plazaPaths, t }));
	}
	if (selections.length) {
		contextBlocks.push(selectionsPromptBlock(selections));
	}
	if (hasVisualDrafts && !isAcpCommand) {
		contextBlocks.push(
			buildVisualAnnotationsPrompt(
				visualDrafts.map((draft) => ({
					page: draft.page,
					comment: draft.comment,
				})),
			),
		);
	}

	const promptBodyParts: string[] = [];
	if (text) promptBodyParts.push(text);
	if (!isAcpCommand && contextBlocks.length) {
		promptBodyParts.push(...contextBlocks);
	}
	const prompt =
		isAcpCommand && text
			? text
			: promptBodyParts.join("\n\n") ||
				(hasVisualDrafts
					? buildVisualAnnotationsPrompt(
							visualDrafts.map((draft) => ({
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
		? visualDrafts.map((draft) => draft.image)
		: [];
	const images =
		visualImages.length || attachedImages.length
			? [...visualImages, ...attachedImages]
			: undefined;

	const visualAnnotations = hasVisualDrafts
		? visualDrafts.map((draft) => ({
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
		text ||
		visualDrafts.find((d) => d.comment.trim())?.comment.trim() ||
		(hasVisualDrafts
			? t("composer.visualAnnotationsTitle", {
					count: visualDrafts.length,
				})
			: hasAttachedImages
				? t("composer.attachedImagesTitle", {
						count: attachedImages.length,
					})
				: t("composer.visualAnnotation"));

	return { prompt, images, visualAnnotations, historyTitle };
}
