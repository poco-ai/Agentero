/**
 * Composer drop capture: OS image files stay image attachments; in-app vault
 * path drags stay @ context chips. Must render inside PromptInput.
 */
import {
	forwardRef,
	type DragEvent as ReactDragEvent,
	type ReactNode,
	useCallback,
	useEffect,
} from "react";
import { useTranslation } from "react-i18next";
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import {
	COMPOSER_IMAGE_MAX_FILES,
	imagePathsFromDataTransfer,
	readComposerImageFiles,
} from "@/lib/agent/prompt-image";
import { subscribeTauriFileDrop } from "@/lib/agent/tauri-file-drop";
import {
	dataTransferLooksLikeImages,
	filesFromDataTransfer,
	hasImageExtension,
} from "@/lib/core/file-accept";
import { notifyError } from "@/lib/core/notify";

export const ComposerDropTarget = forwardRef<
	HTMLDivElement,
	{
		className?: string;
		children: ReactNode;
		onVaultPathDragOver: (e: ReactDragEvent) => void;
		onVaultPathDrop: (e: ReactDragEvent) => void;
	}
>(function ComposerDropTarget(
	{ className, children, onVaultPathDragOver, onVaultPathDrop },
	ref,
) {
	const { t } = useTranslation("agent");
	const attachments = usePromptInputAttachments();
	const addAttachments = attachments.add;
	const attachedCount = attachments.files.length;

	const attachFromPaths = useCallback(
		(paths: string[]) => {
			const imagePaths = paths.filter((path) => hasImageExtension(path));
			if (!imagePaths.length) return false;
			const remaining = Math.max(0, COMPOSER_IMAGE_MAX_FILES - attachedCount);
			void readComposerImageFiles(imagePaths, remaining)
				.then((resolved) => {
					if (resolved.length > 0) {
						addAttachments(resolved);
						return;
					}
					notifyError(t("composer.imageAcceptError"));
				})
				.catch((error) => {
					notifyError(
						error instanceof Error
							? error.message
							: t("composer.imagePickFailed"),
					);
				});
			return true;
		},
		[addAttachments, attachedCount, t],
	);

	useEffect(() => {
		return subscribeTauriFileDrop((payload) => {
			if (payload.type !== "drop") return;
			const imagePaths = payload.paths.filter((path) =>
				hasImageExtension(path),
			);
			if (!imagePaths.length) return;
			const shell = document.querySelector("[data-composer-drop-shell]");
			if (!(shell instanceof HTMLElement)) return;
			// Coordinates from Tauri are unreliable (physical vs CSS, title bar).
			// If the composer is mounted, accept Finder image drops on this window.
			attachFromPaths(imagePaths);
		});
	}, [attachFromPaths]);

	const onDropCapture = (event: ReactDragEvent) => {
		const dt =
			(event.nativeEvent as DragEvent | undefined)?.dataTransfer ??
			event.dataTransfer;
		const imagePaths = imagePathsFromDataTransfer(dt);
		if (dataTransferLooksLikeImages(dt) || imagePaths.length > 0) {
			const files = filesFromDataTransfer(dt);
			if (files.length > 0) {
				event.preventDefault();
				event.stopPropagation();
				addAttachments(files);
				return;
			}
			if (imagePaths.length > 0) {
				event.preventDefault();
				event.stopPropagation();
				attachFromPaths(imagePaths);
			}
			return;
		}
		onVaultPathDrop(event);
	};

	return (
		<div
			ref={ref}
			className={className}
			onDragOverCapture={onVaultPathDragOver}
			onDropCapture={onDropCapture}
		>
			{children}
		</div>
	);
});
