"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMarkdownExportMode } from "@/components/editor/markdown-export-mode-context";
import { PdfViewer } from "@/components/viewer/embed/pdf-viewer";
import { cn } from "@/lib/core/utils";
import { localFileToArrayBuffer } from "@/lib/paper/media";
import { imageMimeFromPath } from "@/lib/workspace/viewer";

type WikiAttachmentEmbedProps = {
	kind: "image" | "pdf";
	absoluteTarget: string;
	targetPath: string;
	revision: number;
	imageSize?: string | null;
};

type AttachmentState =
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "ready"; bytes: ArrayBuffer };

type CachedAttachmentLoad = {
	requestKey: string;
	state: AttachmentState;
};

type ObjectUrlApi = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

export type WikiImageObjectUrlLease = {
	source: string;
	release: () => void;
};

const ATTACHMENT_CACHE_LIMIT = 32;
const attachmentBytesCache = new Map<string, ArrayBuffer>();
const attachmentRequestCache = new Map<string, Promise<ArrayBuffer | null>>();

function attachmentRequestKey(
	kind: "image" | "pdf",
	absoluteTarget: string,
	revision: number,
): string {
	return JSON.stringify([kind, absoluteTarget, revision]);
}

function cachedAttachmentBytes(key: string): ArrayBuffer | undefined {
	return attachmentBytesCache.get(key);
}

function loadAttachmentBytes(
	key: string,
	absoluteTarget: string,
): Promise<ArrayBuffer | null> {
	const cached = cachedAttachmentBytes(key);
	if (cached) return Promise.resolve(cached);
	const pending = attachmentRequestCache.get(key);
	if (pending) return pending;

	const request = localFileToArrayBuffer(absoluteTarget)
		.then((bytes) => {
			if (!bytes) return null;
			attachmentBytesCache.delete(key);
			attachmentBytesCache.set(key, bytes);
			while (attachmentBytesCache.size > ATTACHMENT_CACHE_LIMIT) {
				const oldest = attachmentBytesCache.keys().next().value;
				if (typeof oldest !== "string") break;
				attachmentBytesCache.delete(oldest);
			}
			return bytes;
		})
		.finally(() => {
			attachmentRequestCache.delete(key);
		});
	attachmentRequestCache.set(key, request);
	return request;
}

export type WikiImageEmbedDimensions = {
	width: number;
	height?: number;
};

/** Obsidian image aliases may encode a width (`100`) or size (`100x200`). */
export function parseWikiImageEmbedDimensions(
	value: string | null | undefined,
): WikiImageEmbedDimensions | null {
	const match = value?.trim().match(/^([1-9]\d*)(?:x([1-9]\d*))?$/i);
	if (!match) return null;
	const width = Number(match[1]);
	const height = match[2] ? Number(match[2]) : undefined;
	if (
		!Number.isSafeInteger(width) ||
		(height && !Number.isSafeInteger(height))
	) {
		return null;
	}
	return height ? { width, height } : { width };
}

/**
 * Create one image URL lease for one mounted render.
 *
 * React StrictMode may run an effect as setup → cleanup → setup. Each setup
 * must therefore create a fresh URL instead of reusing one that the preceding
 * cleanup already revoked.
 */
export function createWikiImageObjectUrlLease(
	bytes: ArrayBuffer,
	targetPath: string,
	urlApi: ObjectUrlApi = URL,
): WikiImageObjectUrlLease {
	const source = urlApi.createObjectURL(
		new Blob([bytes], { type: imageMimeFromPath(targetPath) }),
	);
	let active = true;
	return {
		source,
		release: () => {
			if (!active) return;
			active = false;
			urlApi.revokeObjectURL(source);
		},
	};
}

export function WikiAttachmentEmbed({
	kind,
	absoluteTarget,
	targetPath,
	revision,
	imageSize,
}: WikiAttachmentEmbedProps) {
	const { t } = useTranslation("editor");
	const exportMode = useMarkdownExportMode();
	const expandEmbeds = exportMode?.expandEmbeds === true;
	const dimensions = parseWikiImageEmbedDimensions(imageSize);
	const requestKey = attachmentRequestKey(kind, absoluteTarget, revision);
	const [load, setLoad] = useState<CachedAttachmentLoad>(() => {
		const bytes = cachedAttachmentBytes(requestKey);
		return {
			requestKey,
			state: bytes ? { kind: "ready", bytes } : { kind: "loading" },
		};
	});
	const fallbackBytes =
		load.requestKey === requestKey
			? undefined
			: cachedAttachmentBytes(requestKey);
	const state =
		load.requestKey === requestKey
			? load.state
			: fallbackBytes
				? {
						kind: "ready" as const,
						bytes: fallbackBytes,
					}
				: { kind: "loading" as const };
	const attachmentBytes = state.kind === "ready" ? state.bytes : null;
	const imageResourceKey =
		kind === "image" && attachmentBytes
			? JSON.stringify([requestKey, imageMimeFromPath(targetPath)])
			: null;
	const [imageResource, setImageResource] = useState<{
		key: string;
		source: string;
	} | null>(null);
	const imageSource =
		imageResourceKey && imageResource?.key === imageResourceKey
			? imageResource.source
			: null;

	useEffect(() => {
		// Export mode only needs a path placeholder for PDF attachments.
		if (kind === "pdf" && exportMode) {
			setLoad({
				requestKey,
				state: { kind: "ready", bytes: new ArrayBuffer(0) },
			});
			return;
		}
		let cancelled = false;
		const cached = cachedAttachmentBytes(requestKey);
		if (cached) {
			setLoad((previous) =>
				previous.requestKey === requestKey &&
				previous.state.kind === "ready" &&
				previous.state.bytes === cached
					? previous
					: { requestKey, state: { kind: "ready", bytes: cached } },
			);
			return;
		}
		setLoad({ requestKey, state: { kind: "loading" } });
		void loadAttachmentBytes(requestKey, absoluteTarget).then((bytes) => {
			if (cancelled) return;
			setLoad({
				requestKey,
				state: bytes ? { kind: "ready", bytes } : { kind: "error" },
			});
		});

		return () => {
			cancelled = true;
		};
	}, [absoluteTarget, exportMode, kind, requestKey]);

	useEffect(() => {
		if (!imageResourceKey || !attachmentBytes) {
			setImageResource(null);
			return;
		}
		const lease = createWikiImageObjectUrlLease(attachmentBytes, targetPath);
		setImageResource({ key: imageResourceKey, source: lease.source });
		return lease.release;
	}, [attachmentBytes, imageResourceKey, targetPath]);

	if (state.kind === "loading") {
		return (
			<span
				data-export-pending="true"
				className="block px-4 py-3 text-muted-foreground text-sm"
			>
				{t("embed.loading")}
			</span>
		);
	}
	if (state.kind === "error") {
		return (
			<span className="block px-4 py-3 text-muted-foreground text-sm">
				{t("embed.error")}
			</span>
		);
	}
	if (kind === "image" && state.kind === "ready" && imageSource) {
		return (
			<span className="flex justify-center p-3">
				<img
					src={imageSource}
					alt={targetPath}
					className={cn(
						"max-w-full rounded-sm object-contain",
						expandEmbeds ? "max-h-none" : "max-h-96",
					)}
					style={{
						width: dimensions?.width,
						height: dimensions?.height,
					}}
					loading={expandEmbeds ? "eager" : "lazy"}
					draggable={false}
				/>
			</span>
		);
	}
	if (kind === "image" && state.kind === "ready") {
		return (
			<span
				data-export-pending="true"
				className="block px-4 py-3 text-muted-foreground text-sm"
			>
				{t("embed.loading")}
			</span>
		);
	}
	if (state.kind !== "ready") return null;
	// Full PDF viewer is heavy and poorly paginated for note export — show a path placeholder.
	if (exportMode) {
		return (
			<span className="block px-4 py-3 text-muted-foreground text-sm">
				{t("export.pdfEmbedPlaceholder", { path: targetPath })}
			</span>
		);
	}
	return (
		<PdfViewer
			source={null}
			sourceBytes={state.bytes}
			docId={`wiki-embed:${targetPath}:${revision}`}
			className="h-96 w-full"
		/>
	);
}
