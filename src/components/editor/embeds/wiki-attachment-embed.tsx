"use client";

import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmbedStatus } from "@/components/editor/embeds/embed-status";
import { useMarkdownExportMode } from "@/components/editor/markdown-export-mode-context";
import { PdfViewer } from "@/components/viewer";
import { useVaultStore } from "@/hooks/use-app-stores";
import { resolvePdfCitation } from "@/lib/agent/api";
import { errorText } from "@/lib/core/error";
import { createKeyedCache } from "@/lib/core/keyed-cache";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { paperDirFromPath } from "@/lib/paper/detect";
import { findLocalPdfPath, localFileToArrayBuffer } from "@/lib/paper/media";
import { layoutKindFromCitationFragment } from "@/lib/pdf/layout/store";
import type { PdfNavigationTarget } from "@/lib/pdf/pending-pdf-page";
import { normalizePathKey, vaultRelativePath } from "@/lib/vault/path";
import { type LinkFragment, wikiFragmentSuffix } from "@/lib/wiki/api";
import { imageMimeFromPath, isPlainPdfPath } from "@/lib/workspace/viewer";

type WikiAttachmentEmbedProps = {
	kind: "image" | "pdf";
	absoluteTarget: string;
	targetPath: string;
	revision: number;
	imageSize?: string | null;
	vaultPath?: string | null;
	fragment?: LinkFragment | null;
	locateRequest?: number;
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

const attachmentCache = createKeyedCache<ArrayBuffer | null>({
	limit: 32,
	shouldRetain: (bytes) => bytes !== null,
});

function attachmentRequestKey(
	kind: "image" | "pdf",
	absoluteTarget: string,
	revision: number,
): string {
	return JSON.stringify([kind, absoluteTarget, revision]);
}

function loadAttachmentBytes(
	key: string,
	absoluteTarget: string,
): Promise<ArrayBuffer | null> {
	return attachmentCache.load(key, () =>
		localFileToArrayBuffer(absoluteTarget),
	);
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
	vaultPath,
	fragment,
	locateRequest,
}: WikiAttachmentEmbedProps) {
	const { t } = useTranslation("editor");
	const instanceId = useId();
	const exportMode = useMarkdownExportMode();
	const citationSource =
		kind === "pdf" && fragment && !exportMode
			? `${targetPath}${wikiFragmentSuffix(fragment)}`
			: null;
	const citationKey = citationSource
		? JSON.stringify([vaultPath, citationSource, revision])
		: null;
	const [citation, setCitation] = useState<{
		key: string;
		target: PdfNavigationTarget | null;
	} | null>(null);

	useEffect(() => {
		if (!citationKey || !citationSource || !vaultPath) return;
		let cancelled = false;
		void resolvePdfCitation(vaultPath, citationSource).then(
			(target) => {
				if (cancelled) return;
				setCitation({
					key: citationKey,
					target: {
						page: target.pageIndex + 1,
						region: {
							id: target.regionId,
							pageIndex: target.pageIndex,
							bbox: target.bbox,
							kind: layoutKindFromCitationFragment(target.fragment),
						},
					},
				});
			},
			(error) => {
				if (cancelled) return;
				setCitation({ key: citationKey, target: null });
				notifyError(t("embed.error"), { description: errorText(error) });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [citationKey, citationSource, vaultPath, t]);
	const expandEmbeds = exportMode?.expandEmbeds === true;
	const dimensions = parseWikiImageEmbedDimensions(imageSize);
	const requestKey = attachmentRequestKey(kind, absoluteTarget, revision);
	const paperFolders = useVaultStore((state) => state.paperFolders);
	const paperRoot =
		kind === "pdf" && vaultPath
			? paperDirFromPath(absoluteTarget, paperFolders)
			: null;
	const paperContextKey =
		paperRoot && !exportMode ? JSON.stringify([requestKey, paperRoot]) : null;
	const [paperContext, setPaperContext] = useState<{
		key: string;
		path: string | null;
	} | null>(null);
	useEffect(() => {
		if (!paperContextKey || !paperRoot) return;
		let cancelled = false;
		void findLocalPdfPath(paperRoot).then((primaryPdf) => {
			if (cancelled) return;
			setPaperContext({
				key: paperContextKey,
				path:
					primaryPdf &&
					normalizePathKey(primaryPdf) === normalizePathKey(absoluteTarget)
						? paperRoot
						: null,
			});
		});
		return () => {
			cancelled = true;
		};
	}, [paperContextKey, paperRoot, absoluteTarget]);
	const paperAbsPath =
		paperContext?.key === paperContextKey ? paperContext?.path : null;
	const [load, setLoad] = useState<CachedAttachmentLoad>(() => {
		const bytes = attachmentCache.get(requestKey);
		return {
			requestKey,
			state: bytes ? { kind: "ready", bytes } : { kind: "loading" },
		};
	});
	const fallbackBytes =
		load.requestKey === requestKey
			? undefined
			: attachmentCache.get(requestKey);
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
		const cached = attachmentCache.get(requestKey);
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
		return <EmbedStatus exportPending message={t("embed.loading")} />;
	}
	if (state.kind === "error") {
		return <EmbedStatus message={t("embed.error")} />;
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
		return <EmbedStatus exportPending message={t("embed.loading")} />;
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
	if (citationKey) {
		if (!vaultPath || (citation?.key === citationKey && !citation.target)) {
			return <EmbedStatus message={t("embed.error")} />;
		}
		if (citation?.key !== citationKey) {
			return <EmbedStatus message={t("embed.loading")} />;
		}
	}
	if (paperContextKey && paperContext?.key !== paperContextKey) {
		return <EmbedStatus message={t("embed.loading")} />;
	}
	return (
		<PdfViewer
			source={null}
			sourceBytes={state.bytes}
			docId={`wiki-embed:${instanceId}:${targetPath}:${revision}`}
			embeddedTarget={citationKey === citation?.key ? citation?.target : null}
			embeddedTargetRequest={locateRequest}
			rememberReadingPosition={false}
			paperAbsPath={paperAbsPath}
			paperRelPath={
				paperAbsPath && vaultPath
					? vaultRelativePath(vaultPath, paperAbsPath)
					: null
			}
			vaultPath={vaultPath}
			pdfPath={absoluteTarget}
			plainViewer={isPlainPdfPath(targetPath) || !paperAbsPath}
			className="h-96 w-full"
		/>
	);
}
