import {
	ChevronDown,
	ChevronUp,
	Link2,
	MessageCircle,
	MessageSquareText,
	Pencil,
	ScanSearch,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PaneHeader } from "@/components/shell/pane-header";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";
import type { PdfVisualTraceThumbnail } from "@/lib/pdf/agent-trace/thumbnail";
import { annotationWikilinkMarkdown } from "@/lib/pdf/annotation-ref";
import {
	type HighlightColor,
	swatchBorderClass,
	swatchColorClass,
} from "@/lib/pdf/highlight/palette";

export type AnnotationRow = {
	id: string;
	page: number;
	quote: string;
	comment: string;
	color: HighlightColor;
	/** Full wikilink alias (`Title·snippet`) when copying. */
	linkAlias?: string | null;
};

/** PDF selection-ask conversation for the annotations sidebar. */
export type AskRow = {
	id: string;
	page: number;
	/** First user question summary (梗概). */
	preview: string;
	messageCount: number;
};

/** Visual agent-trace mark (PDF region → Agent session). */
export type VisualTraceRow = {
	id: string;
	page: number;
	/** Truncated user comment for this crop. */
	preview: string;
	/** Full wikilink alias (`Title·snippet`) when copying. */
	linkAlias?: string | null;
	/** Crop thumbnail for visual marks. */
	thumbnail?: PdfVisualTraceThumbnail | null;
};

type AnnotationsPanelProps = {
	items: AnnotationRow[];
	/** PDF ask threads with at least one user message. */
	asks?: AskRow[];
	/** Visual agent-trace marks for this paper. */
	visualTraces?: VisualTraceRow[];
	/**
	 * Resolvable wiki target for `[[target@id]]` (e.g. `papers/…/NOTES`).
	 * When set, highlight and visual cards expose copy-link / copy-embed.
	 */
	wikiTarget?: string | null;
	onJump: (id: string) => void;
	onEdit: (id: string) => void;
	onDelete: (id: string) => void;
	onJumpAsk?: (id: string) => void;
	onDeleteAsk?: (id: string) => void;
	onJumpVisual?: (id: string) => void;
	onDeleteVisual?: (id: string) => void;
	className?: string;
};

/** Character threshold: longer notes get clamp + expand control. */
const COMMENT_COLLAPSE_CHARS = 120;
const COMMENT_CLAMP_CLASS = "line-clamp-3";

/**
 * Right-sidebar overview of highlights, PDF ask threads, and visual agent-trace
 * marks on the active paper. Click to jump; long notes clamp with expand.
 */
export function AnnotationsPanel({
	items,
	asks = [],
	visualTraces = [],
	wikiTarget = null,
	onJump,
	onEdit,
	onDelete,
	onJumpAsk,
	onDeleteAsk,
	onJumpVisual,
	onDeleteVisual,
	className,
}: AnnotationsPanelProps) {
	const { t } = useTranslation("viewer");
	const total = items.length + asks.length + visualTraces.length;
	const multiSection =
		[items.length > 0, asks.length > 0, visualTraces.length > 0].filter(Boolean)
			.length > 1;
	const linkTarget = wikiTarget?.trim() || null;

	return (
		<section
			className={cn(
				"flex h-full min-h-0 flex-col overflow-hidden bg-background",
				className,
			)}
			aria-label={t("annotations.panelAria")}
		>
			<PaneHeader>
				<MessageSquareText
					className="size-4 text-muted-foreground"
					aria-hidden
				/>
				<span className="font-medium text-sm">{t("annotations.title")}</span>
			</PaneHeader>

			{total === 0 ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
					<div className="flex size-12 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground">
						<MessageSquareText className="size-5" aria-hidden />
					</div>
					<p className="max-w-[15rem] text-muted-foreground text-xs leading-relaxed">
						{t("annotations.empty")}
					</p>
				</div>
			) : (
				<div className="agentero-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
					{items.length > 0 ? (
						<section aria-label={t("annotations.sectionHighlights")}>
							{multiSection ? (
								<h3 className="mb-1.5 px-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
									{t("annotations.sectionHighlights")}
								</h3>
							) : null}
							<ul className="space-y-1">
								{items.map((a) => (
									<li key={a.id}>
										<AnnotationCard
											item={a}
											wikiTarget={linkTarget}
											onJump={onJump}
											onEdit={onEdit}
											onDelete={onDelete}
										/>
									</li>
								))}
							</ul>
						</section>
					) : null}

					{asks.length > 0 ? (
						<section aria-label={t("annotations.sectionAsks")}>
							{multiSection ? (
								<h3 className="mb-1.5 px-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
									{t("annotations.sectionAsks")}
								</h3>
							) : null}
							<ul className="space-y-1">
								{asks.map((ask) => (
									<li key={ask.id}>
										<AskCard
											item={ask}
											onJump={onJumpAsk}
											onDelete={onDeleteAsk}
										/>
									</li>
								))}
							</ul>
						</section>
					) : null}

					{visualTraces.length > 0 ? (
						<section aria-label={t("annotations.sectionVisual")}>
							{multiSection ? (
								<h3 className="mb-1.5 px-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
									{t("annotations.sectionVisual")}
								</h3>
							) : null}
							<ul className="space-y-1">
								{visualTraces.map((trace) => (
									<li key={trace.id}>
										<VisualTraceListCard
											item={trace}
											wikiTarget={linkTarget}
											onJump={onJumpVisual}
											onDelete={onDeleteVisual}
										/>
									</li>
								))}
							</ul>
						</section>
					) : null}
				</div>
			)}
		</section>
	);
}

function AnnotationCard({
	item: a,
	wikiTarget,
	onJump,
	onEdit,
	onDelete,
}: {
	item: AnnotationRow;
	wikiTarget: string | null;
	onJump: (id: string) => void;
	onEdit: (id: string) => void;
	onDelete: (id: string) => void;
}) {
	const { t } = useTranslation("viewer");
	const linkOpts = wikiTarget
		? {
				target: wikiTarget,
				id: a.id,
				...(a.linkAlias ? { alias: a.linkAlias } : {}),
			}
		: null;

	return (
		<div className="group relative rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-border/60 hover:bg-muted/40">
			{/* biome-ignore lint/a11y/useSemanticElements: a native <button> cannot wrap the blockquote/p flow content */}
			<div
				role="button"
				tabIndex={0}
				className="block w-full cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				onClick={() => onJump(a.id)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onJump(a.id);
					}
				}}
			>
				<div className="flex items-center gap-1.5">
					<span
						className={cn(
							"size-2 shrink-0 rounded-full",
							swatchColorClass(a.color),
						)}
						aria-hidden
					/>
					<span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider tabular-nums">
						{t("annotations.pageLabel", { page: a.page })}
					</span>
				</div>
				<blockquote
					className={cn(
						"mt-1.5 line-clamp-2 border-l-2 pl-2.5 text-xs leading-relaxed",
						swatchBorderClass(a.color),
						a.comment ? "text-muted-foreground/90" : "text-muted-foreground",
					)}
				>
					{a.quote}
				</blockquote>
				{a.comment ? (
					<div className="mt-2">
						<ExpandableText
							text={a.comment}
							className="whitespace-pre-wrap break-words text-[13px] text-foreground/80 leading-relaxed"
						/>
					</div>
				) : null}
			</div>
			<div className="absolute top-2 right-2 flex items-center gap-0.5 rounded-lg bg-background/80 p-0.5 opacity-0 shadow-sm ring-1 ring-border/60 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
				{linkOpts ? (
					<>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="size-6 text-muted-foreground hover:text-foreground"
							aria-label={t("annotations.copyLink")}
							title={t("annotations.copyLink")}
							onClick={() =>
								void copyTextToClipboard(annotationWikilinkMarkdown(linkOpts), {
									successMessage: t("annotations.linkCopied"),
								})
							}
						>
							<Link2 className="size-3.5" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="size-6 text-muted-foreground hover:text-foreground"
							aria-label={t("annotations.copyEmbed")}
							title={t("annotations.copyEmbed")}
							onClick={() =>
								void copyTextToClipboard(
									annotationWikilinkMarkdown({
										...linkOpts,
										embed: true,
									}),
									{ successMessage: t("annotations.embedCopied") },
								)
							}
						>
							<span className="font-mono text-[10px] leading-none">![[</span>
						</Button>
					</>
				) : null}
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className="size-6 text-muted-foreground hover:text-foreground"
					aria-label={t("selection.editComment")}
					onClick={() => onEdit(a.id)}
				>
					<Pencil className="size-3.5" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className="size-6 text-muted-foreground hover:text-destructive"
					aria-label={t("annotations.delete")}
					onClick={() => onDelete(a.id)}
				>
					<Trash2 className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}

function AskCard({
	item: ask,
	onJump,
	onDelete,
}: {
	item: AskRow;
	onJump?: (id: string) => void;
	onDelete?: (id: string) => void;
}) {
	const { t } = useTranslation("viewer");

	return (
		<div className="group relative rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-border/60 hover:bg-muted/40">
			{/* biome-ignore lint/a11y/useSemanticElements: role=button wrapper for card jump */}
			<div
				role="button"
				tabIndex={0}
				className="block w-full cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				onClick={() => onJump?.(ask.id)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onJump?.(ask.id);
					}
				}}
			>
				<div className="flex items-center gap-1.5">
					<MessageCircle
						className="size-3 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider tabular-nums">
						{t("annotations.pageLabel", { page: ask.page })}
					</span>
					{ask.messageCount > 0 ? (
						<span className="text-[10px] text-muted-foreground/80 tabular-nums">
							{t("annotations.askTurns", { count: ask.messageCount })}
						</span>
					) : null}
				</div>
				<p className="mt-1.5 line-clamp-2 text-[13px] text-foreground leading-relaxed">
					{ask.preview}
				</p>
			</div>
			{onDelete ? (
				<div className="absolute top-2 right-2 flex items-center gap-0.5 rounded-lg bg-background/80 p-0.5 opacity-0 shadow-sm ring-1 ring-border/60 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="size-6 text-muted-foreground hover:text-destructive"
						aria-label={t("annotations.deleteAsk")}
						onClick={() => onDelete(ask.id)}
					>
						<Trash2 className="size-3.5" />
					</Button>
				</div>
			) : null}
		</div>
	);
}

function VisualTraceListCard({
	item: trace,
	wikiTarget,
	onJump,
	onDelete,
}: {
	item: VisualTraceRow;
	wikiTarget: string | null;
	onJump?: (id: string) => void;
	onDelete?: (id: string) => void;
}) {
	const { t } = useTranslation("viewer");
	const linkOpts = wikiTarget
		? {
				target: wikiTarget,
				id: trace.id,
				...(trace.linkAlias ? { alias: trace.linkAlias } : {}),
			}
		: null;

	return (
		<div className="group relative rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-border/60 hover:bg-muted/40">
			{/* biome-ignore lint/a11y/useSemanticElements: role=button wrapper for card jump */}
			<div
				role="button"
				tabIndex={0}
				className="block w-full cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				onClick={() => onJump?.(trace.id)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onJump?.(trace.id);
					}
				}}
			>
				<div className="flex items-center gap-1.5">
					<ScanSearch
						className="size-3 shrink-0 text-violet-600 dark:text-violet-400"
						aria-hidden
					/>
					<span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider tabular-nums">
						{t("annotations.pageLabel", { page: trace.page })}
					</span>
				</div>
				<p className="mt-1.5 line-clamp-2 text-[13px] text-foreground leading-relaxed">
					{trace.preview}
				</p>
				{trace.thumbnail?.data ? (
					<img
						src={`data:${trace.thumbnail.mimeType || "image/png"};base64,${trace.thumbnail.data}`}
						alt={t("pdfExplain.annotationPreviewAlt", { page: trace.page })}
						className="mt-2 max-h-28 w-full rounded-md border border-border/70 bg-muted/30 object-contain"
						loading="lazy"
					/>
				) : null}
			</div>
			{onDelete || wikiTarget ? (
				<div className="absolute top-2 right-2 flex items-center gap-0.5 rounded-lg bg-background/80 p-0.5 opacity-0 shadow-sm ring-1 ring-border/60 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
					{linkOpts ? (
						<>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="size-6 text-muted-foreground hover:text-foreground"
								aria-label={t("annotations.copyLink")}
								title={t("annotations.copyLink")}
								onClick={() =>
									void copyTextToClipboard(
										annotationWikilinkMarkdown(linkOpts),
										{ successMessage: t("annotations.linkCopied") },
									)
								}
							>
								<Link2 className="size-3.5" />
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="size-6 text-muted-foreground hover:text-foreground"
								aria-label={t("annotations.copyEmbed")}
								title={t("annotations.copyEmbed")}
								onClick={() =>
									void copyTextToClipboard(
										annotationWikilinkMarkdown({
											...linkOpts,
											embed: true,
										}),
										{ successMessage: t("annotations.embedCopied") },
									)
								}
							>
								<span className="font-mono text-[10px] leading-none">![[</span>
							</Button>
						</>
					) : null}
					{onDelete ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="size-6 text-muted-foreground hover:text-destructive"
							aria-label={t("annotations.deleteVisual")}
							onClick={() => onDelete(trace.id)}
						>
							<Trash2 className="size-3.5" />
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * Clamp long text to a few lines; show a chevron control to expand/collapse.
 * Short notes render in full with no control.
 */
function ExpandableText({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const { t } = useTranslation("viewer");
	const [expanded, setExpanded] = useState(false);
	const collapsible =
		text.length > COMMENT_COLLAPSE_CHARS || text.split("\n").length > 3;

	if (!collapsible) {
		return <p className={className}>{text}</p>;
	}

	return (
		<div className="relative">
			<p className={cn(className, !expanded && COMMENT_CLAMP_CLASS)}>{text}</p>
			<button
				type="button"
				className={cn(
					"mt-0.5 inline-flex size-6 items-center justify-center rounded-md",
					"text-muted-foreground transition-colors",
					"hover:bg-muted hover:text-foreground",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				)}
				aria-expanded={expanded}
				aria-label={
					expanded ? t("annotations.collapseNote") : t("annotations.expandNote")
				}
				title={
					expanded ? t("annotations.collapseNote") : t("annotations.expandNote")
				}
				onClick={(e) => {
					e.stopPropagation();
					setExpanded((v) => !v);
				}}
			>
				{expanded ? (
					<ChevronUp className="size-3.5" aria-hidden />
				) : (
					<ChevronDown className="size-3.5" aria-hidden />
				)}
			</button>
		</div>
	);
}
