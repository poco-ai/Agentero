"use client";

import { NotebookPen } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { MessageResponse } from "@/components/agent/message";
import { EmbedStatus } from "@/components/editor/embeds/embed-status";
import { useMarkdownExportMode } from "@/components/editor/markdown-export-mode-context";
import { AnnotationQuoteBlock } from "@/components/selection/annotation-quote-block";
import { createKeyedCache } from "@/lib/core/keyed-cache";
import { cn } from "@/lib/core/utils";

/** Cited excerpt: location, quote, and its translation. */
const EMBED_SOURCE_TEXT = "text-[length:var(--wiki-embed-font-size,13px)]";
/** Notes follow the editor body size. Beats MessageResponse's `text-base`. */
const EMBED_NOTE_TEXT = "!text-[length:inherit]";

import { visualTraceImageAssetRelPath } from "@/lib/pdf/agent-trace/image";
import {
	type AnnotationRef,
	annotationAnchorY,
	lookupAnnotationRef,
	paperAbsFromWikiTarget,
} from "@/lib/pdf/annotation-ref";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import {
	annotationTranslateSidecarPath,
	readAnnotationTranslation,
} from "@/lib/pdf/layout/annotation-translate-display";
import {
	getPaperOutline,
	outlineLocationLabelForPaper,
	subscribePaperOutline,
} from "@/lib/pdf/outline-location";
import { ANNOTATIONS_JSON, MARKS_FOLDER } from "@/lib/pdf/selection/marks-io";
import { joinVaultPath } from "@/lib/vault";
import { subscribeWikiEmbedTarget } from "@/lib/wiki/embed-refresh";

const ANNOTATION_REF_CACHE_LIMIT = 64;

type WikiAnnotationEmbedProps = {
	vaultPath: string;
	/** Vault-relative wiki target path (NOTES / pdf / paper). */
	targetPath: string;
	annotationId: string;
	/** Notify parent so shared header can pick highlight vs visual icon. */
	onResolvedKind?: (kind: AnnotationRef["kind"]) => void;
	className?: string;
};

type AnnotationLoadState =
	| { kind: "loading" }
	| { kind: "missing" }
	| { kind: "ready"; ref: AnnotationRef };

const annotationCache = createKeyedCache<AnnotationLoadState>({
	limit: ANNOTATION_REF_CACHE_LIMIT,
	shouldRetain: (state) => state.kind !== "loading",
	isFresh: (state) => state.kind !== "loading",
});

function annotationCacheKey(
	vaultPath: string,
	targetPath: string,
	annotationId: string,
	revision: number,
): string {
	return JSON.stringify([vaultPath, targetPath, annotationId, revision]);
}

function loadAnnotationState(
	key: string,
	vaultPath: string,
	targetPath: string,
	annotationId: string,
): Promise<AnnotationLoadState> {
	const paperAbs = paperAbsFromWikiTarget(vaultPath, targetPath);
	return annotationCache.load(key, () =>
		lookupAnnotationRef(paperAbs, annotationId, { includeImage: true }).then(
			(ref): AnnotationLoadState =>
				ref ? { kind: "ready", ref } : { kind: "missing" },
		),
	);
}

/**
 * Absolute mark files that back one annotation embed. Subscribe to these — not
 * NOTES.md — so editing the hosting note never invalidates the projection.
 */
export function annotationEmbedWatchPaths(
	vaultPath: string,
	targetPath: string,
	annotationId: string,
): string[] {
	const paperAbs = paperAbsFromWikiTarget(vaultPath, targetPath);
	if (!paperAbs || !annotationId) return [];
	return [
		joinVaultPath(joinVaultPath(paperAbs, MARKS_FOLDER), ANNOTATIONS_JSON),
		joinVaultPath(
			joinVaultPath(paperAbs, MARKS_FOLDER),
			`${annotationId}.json`,
		),
		joinVaultPath(
			joinVaultPath(paperAbs, MARKS_FOLDER),
			visualTraceImageAssetRelPath(annotationId, "image/png"),
		),
		annotationTranslateSidecarPath(paperAbs),
	];
}

function locationLabelForRef(ref: AnnotationRef): string | null {
	const y = annotationAnchorY(ref.rects);
	const keys = [ref.paperAbsPath];
	for (const key of keys) {
		const label = outlineLocationLabelForPaper(key, {
			page: ref.page,
			...(y != null ? { y } : {}),
		});
		if (label) return label;
	}
	return null;
}

/**
 * Body-only projection of a PDF highlight / visual-trace for `![[target@id]]`.
 * Title + type icon live in the shared embed chrome (wiki-embed-node).
 * Long content scrolls via the outer embed shell (`max-h-96 overflow-auto`).
 */
export const WikiAnnotationEmbed = memo(function WikiAnnotationEmbed({
	vaultPath,
	targetPath,
	annotationId,
	onResolvedKind,
	className,
}: WikiAnnotationEmbedProps) {
	const { t } = useTranslation("editor");
	const exportMode = useMarkdownExportMode();
	const expandEmbeds = exportMode?.expandEmbeds === true;
	const [marksRevision, setMarksRevision] = useState(0);
	/** Bumped when PDF viewer fills outline cache — forces location re-read. */
	const [outlineTick, setOutlineTick] = useState(0);
	const requestKey = annotationCacheKey(
		vaultPath,
		targetPath,
		annotationId,
		marksRevision,
	);
	const [load, setLoad] = useState<{
		requestKey: string;
		state: AnnotationLoadState;
	}>(() => ({
		requestKey,
		state: annotationCache.get(requestKey) ?? { kind: "loading" },
	}));
	const fallback =
		load.requestKey === requestKey
			? undefined
			: annotationCache.get(requestKey);
	const state: AnnotationLoadState =
		load.requestKey === requestKey
			? load.state
			: (fallback ??
				(load.state.kind === "ready" ? load.state : { kind: "loading" }));

	const paperAbs = useMemo(
		() => paperAbsFromWikiTarget(vaultPath, targetPath),
		[vaultPath, targetPath],
	);

	useEffect(() => {
		const paths = annotationEmbedWatchPaths(
			vaultPath,
			targetPath,
			annotationId,
		);
		if (!paths.length) return;
		const unsubs = paths.map((path) =>
			subscribeWikiEmbedTarget(path, () => {
				setMarksRevision((revision) => revision + 1);
			}),
		);
		return () => {
			for (const unsub of unsubs) unsub();
		};
	}, [vaultPath, targetPath, annotationId]);

	useEffect(() => {
		if (!paperAbs) return;
		// Re-render location label when PdfViewer fills the outline cache.
		if (getPaperOutline(paperAbs)?.length) {
			setOutlineTick((n) => n + 1);
		}
		return subscribePaperOutline(paperAbs, () => {
			setOutlineTick((n) => n + 1);
		});
	}, [paperAbs]);

	useEffect(() => {
		const cached = annotationCache.get(requestKey);
		if (cached && cached.kind !== "loading") {
			setLoad((previous) =>
				previous.requestKey === requestKey && previous.state === cached
					? previous
					: { requestKey, state: cached },
			);
			return;
		}

		let cancelled = false;
		void loadAnnotationState(
			requestKey,
			vaultPath,
			targetPath,
			annotationId,
		).then((nextState) => {
			if (!cancelled) setLoad({ requestKey, state: nextState });
		});
		return () => {
			cancelled = true;
		};
	}, [requestKey, vaultPath, targetPath, annotationId]);

	const highlightQuote =
		state.kind === "ready" && state.ref.kind === "highlight"
			? (state.ref.quote?.trim() ?? "")
			: "";
	const [translation, setTranslation] = useState<{
		key: string;
		text: string | null;
	}>({ key: "", text: null });
	useEffect(() => {
		// Sidecar writes bump marksRevision without changing the stored quote.
		void marksRevision;
		if (!paperAbs || !highlightQuote) return;
		const key = `${paperAbs}\n${highlightQuote}`;
		let cancelled = false;
		void readAnnotationTranslation(paperAbs, highlightQuote).then((text) => {
			if (!cancelled) setTranslation({ key, text });
		});
		return () => {
			cancelled = true;
		};
	}, [paperAbs, highlightQuote, marksRevision]);
	const pairedTranslation =
		paperAbs && translation.key === `${paperAbs}\n${highlightQuote}`
			? translation.text
			: null;

	const resolvedKind = state.kind === "ready" ? state.ref.kind : null;
	useEffect(() => {
		if (resolvedKind) onResolvedKind?.(resolvedKind);
	}, [resolvedKind, onResolvedKind]);

	// Read outline cache each render; outlineTick invalidates after PDF open.
	void outlineTick;
	const locationLabel =
		state.kind === "ready"
			? locationLabelForRef(state.ref) ||
				t("embed.annotationPage", { page: state.ref.page })
			: null;

	if (state.kind === "loading") {
		return (
			<EmbedStatus
				compact
				exportPending
				message={t("embed.loading")}
				className={className}
			/>
		);
	}

	if (state.kind === "missing") {
		return (
			<EmbedStatus
				compact
				message={t("embed.invalidFragment")}
				className={className}
			/>
		);
	}

	const { ref } = state;
	const color: HighlightColor = ref.color ?? "yellow";
	const isVisual = ref.kind === "visual" || ref.kind === "agent-trace";
	const hasQuote = Boolean(ref.quote?.trim());
	const hasComment = Boolean(ref.comment?.trim());
	const hasImage = Boolean(isVisual && ref.image?.data);
	// Conversation turns only — never synthesize from comment. Note-only marks
	// leave this empty so the embed shows note + crop without a transcript block.
	const messages = isVisual ? (ref.messages ?? []) : [];
	const hasTranscript = messages.length > 0;

	// Body is not a jump target — open via shared chrome ExternalLink only
	// (same as markdown / attachment embeds) so selection & scroll stay usable.
	return (
		<div className={cn("block w-full px-3 py-2 text-left", className)}>
			<AnnotationQuoteBlock
				quote={hasQuote ? ref.quote : null}
				translation={pairedTranslation && !isVisual ? pairedTranslation : null}
				locationLabel={locationLabel}
				color={color}
				showSwatch={!isVisual}
				textClassName={EMBED_SOURCE_TEXT}
			/>

			{/* Visual note: icon + text above the crop (annotation, not chat). */}
			{isVisual && hasComment ? (
				<div
					className={cn(
						"flex min-w-0 items-start gap-1.5 text-foreground/90 leading-relaxed",
						hasQuote ? "mt-2" : "mt-1.5",
					)}
				>
					<NotebookPen
						className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<MessageResponse
						className={cn(
							"min-w-0 flex-1 leading-relaxed [&_p]:my-0",
							EMBED_NOTE_TEXT,
						)}
					>
						{ref.comment}
					</MessageResponse>
				</div>
			) : null}

			{/* Visual crop — capped in editor so conversation can still scroll below */}
			{hasImage ? (
				<img
					src={`data:${ref.image?.mimeType || "image/png"};base64,${ref.image?.data}`}
					alt=""
					className={cn(
						"w-full rounded border border-border/60 object-contain",
						expandEmbeds ? "max-h-none" : "max-h-40",
						hasQuote || (isVisual && hasComment) ? "mt-2" : "mt-1.5",
					)}
				/>
			) : null}

			{/* Highlight note: markdown when present, outer embed scrolls */}
			{ref.kind === "highlight" && hasComment ? (
				<div
					className={cn(
						"min-w-0 text-foreground/85 leading-relaxed",
						hasQuote || hasImage ? "mt-2" : "mt-1.5",
					)}
				>
					<MessageResponse className={cn("leading-relaxed", EMBED_NOTE_TEXT)}>
						{ref.comment}
					</MessageResponse>
				</div>
			) : null}

			{/* Visual conversation: only when agent messages exist (no empty placeholder). */}
			{isVisual && hasTranscript ? (
				<div
					className={cn(
						"space-y-2",
						hasQuote || hasImage || hasComment ? "mt-2" : "mt-1.5",
					)}
				>
					{messages.map((m) => (
						<div
							key={m.id}
							className={cn(
								"min-w-0 rounded-md px-2.5 py-1.5 leading-relaxed",
								m.role === "user"
									? "bg-primary/10 text-foreground/90"
									: "bg-muted/70 text-foreground/85",
							)}
						>
							<div className="mb-0.5 font-medium text-caption text-muted-foreground uppercase tracking-wider">
								{m.role === "user"
									? t("embed.annotationRoleUser")
									: t("embed.annotationRoleAssistant")}
							</div>
							<MessageResponse
								className={cn("leading-relaxed", EMBED_NOTE_TEXT)}
							>
								{m.content}
							</MessageResponse>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
});
