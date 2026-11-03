import { ImageIcon, ScanSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChatImageGallery } from "@/components/agent/chat-image-gallery";
import type { PromptImage } from "@/lib/agent/api";
import type { ChatVisualAnnotation } from "@/lib/agent/chat-state";

function promptImageSrc(image: PromptImage): string | null {
	if (!image.data) return null;
	return `data:${image.mimeType || "image/png"};base64,${image.data}`;
}

/** Visual crops retain their page, source and comment in the shared image preview. */
export function ChatVisualAnnotations({
	annotations,
	className,
}: {
	annotations: ChatVisualAnnotation[];
	className?: string;
}) {
	const { t } = useTranslation("agent");
	return (
		<ChatImageGallery
			className={className}
			items={annotations.map((annotation, index) => {
				const pageLabel = t("composer.visualAnnotationPage", {
					page: annotation.page,
				});
				const label =
					annotation.comment.trim() ||
					`${t("composer.visualAnnotation")} · ${pageLabel}`;
				return {
					id: annotation.id,
					src: promptImageSrc(annotation.image),
					openLabel: t("composer.visualAnnotationOpen"),
					accessibleLabel: t("composer.visualAnnotationOpenAria", {
						index: index + 1,
						label,
					}),
					title: t("composer.visualAnnotationDetailTitle", {
						index: index + 1,
					}),
					description: `${pageLabel}${annotation.paperPath ? ` · ${annotation.paperPath}` : ""}`,
					previewAlt: t("composer.visualAnnotationPreviewAlt", {
						page: annotation.page,
					}),
					fallback: <ScanSearch className="size-3.5 text-muted-foreground" />,
					details: (
						<div className="space-y-1">
							<p className="font-medium text-muted-foreground text-xs">
								{t("composer.visualAnnotationCommentLabel")}
							</p>
							<p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
								{annotation.comment.trim() ||
									t("composer.visualAnnotationNoComment")}
							</p>
						</div>
					),
				};
			})}
		/>
	);
}

/** General image attachments use the same thumbnail and preview interaction. */
export function ChatAttachedImages({
	images,
	className,
}: {
	images: PromptImage[];
	className?: string;
}) {
	const { t } = useTranslation("agent");
	return (
		<ChatImageGallery
			className={className}
			items={images.map((image, index) => ({
				id: `${image.mimeType}:${image.data.slice(0, 32)}:${index}`,
				src: promptImageSrc(image),
				openLabel: t("composer.attachedImageOpen"),
				accessibleLabel: t("composer.attachedImageOpenAria", {
					index: index + 1,
				}),
				title: t("composer.attachedImageDetailTitle", { index: index + 1 }),
				description: t("composer.attachedImagePreviewAlt", {
					index: index + 1,
				}),
				hideDescription: true,
				previewAlt: t("composer.attachedImagePreviewAlt", { index: index + 1 }),
				fallback: <ImageIcon className="size-3.5 text-muted-foreground" />,
			}))}
		/>
	);
}

/** Plain-text export of free text + visual comments (copy / edit seed). */
export function formatUserLineForCopy(line: {
	text: string;
	visualAnnotations?: ChatVisualAnnotation[];
	images?: PromptImage[];
}): string {
	const parts: string[] = [];
	const free = line.text.trim();
	if (free) parts.push(free);
	const visuals = line.visualAnnotations ?? [];
	if (visuals.length) {
		parts.push(
			...visuals.map((item, index) => {
				const comment = item.comment.trim();
				return comment
					? `${index + 1}. ${comment}`
					: `${index + 1}. (p.${item.page})`;
			}),
		);
	}
	const images = line.images ?? [];
	if (images.length) {
		parts.push(
			images.length === 1
				? "(1 image attachment)"
				: `(${images.length} image attachments)`,
		);
	}
	return parts.join("\n");
}
