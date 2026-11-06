import {
	Link2,
	MessageCircle,
	MessageSquareText,
	ScanSearch,
	Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { PaneHeader } from "@/components/shell/pane-header";
import { QuietIconButton } from "@/components/ui/quiet-icon-button";
import {
	PanelCard,
	PanelCardActions,
	PanelCardButton,
	PanelEmptyState,
} from "@/components/viewer/panels/panel-primitives";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";
import type { PdfVisualTraceThumbnail } from "@/lib/pdf/agent-trace/thumbnail";
import { annotationWikilinkMarkdown } from "@/lib/pdf/annotation-ref";

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
	/** PDF ask threads with at least one user message. */
	asks?: AskRow[];
	/** Visual agent-trace marks for this paper. */
	visualTraces?: VisualTraceRow[];
	/**
	 * Resolvable wiki target for `[[target@id]]` (e.g. `papers/…/NOTES`).
	 * When set, visual cards expose copy-link / copy-embed.
	 */
	wikiTarget?: string | null;
	onJumpAsk?: (id: string) => void;
	onDeleteAsk?: (id: string) => void;
	onJumpVisual?: (id: string) => void;
	onDeleteVisual?: (id: string) => void;
	className?: string;
};

/**
 * Right-sidebar overview of PDF ask threads and visual agent-trace marks on
 * the active paper. Click to jump.
 */
export function AnnotationsPanel({
	asks = [],
	visualTraces = [],
	wikiTarget = null,
	onJumpAsk,
	onDeleteAsk,
	onJumpVisual,
	onDeleteVisual,
	className,
}: AnnotationsPanelProps) {
	const { t } = useTranslation("viewer");
	const total = asks.length + visualTraces.length;
	const multiSection = asks.length > 0 && visualTraces.length > 0;
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
				<PanelEmptyState
					icon={<MessageSquareText className="size-5" aria-hidden />}
					text={t("annotations.empty")}
				/>
			) : (
				<div className="agentero-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
					{asks.length > 0 ? (
						<section aria-label={t("annotations.sectionAsks")}>
							{multiSection ? (
								<h3 className="mb-1.5 px-1 font-medium text-xs text-muted-foreground uppercase tracking-wider">
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
								<h3 className="mb-1.5 px-1 font-medium text-xs text-muted-foreground uppercase tracking-wider">
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
		<PanelCard>
			<PanelCardButton onActivate={() => onJump?.(ask.id)}>
				<div className="flex items-center gap-1.5">
					<MessageCircle
						className="size-3 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<span className="font-medium text-xs text-muted-foreground uppercase tracking-wider tabular-nums">
						{t("annotations.pageLabel", { page: ask.page })}
					</span>
					{ask.messageCount > 0 ? (
						<span className="text-caption text-muted-foreground/80 tabular-nums">
							{t("annotations.askTurns", { count: ask.messageCount })}
						</span>
					) : null}
				</div>
				<p className="mt-1.5 line-clamp-2 text-sm text-foreground leading-relaxed">
					{ask.preview}
				</p>
			</PanelCardButton>
			{onDelete ? (
				<PanelCardActions>
					<QuietIconButton
						tone="destructive"
						aria-label={t("annotations.deleteAsk")}
						onClick={() => onDelete(ask.id)}
					>
						<Trash2 className="size-3.5" />
					</QuietIconButton>
				</PanelCardActions>
			) : null}
		</PanelCard>
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
		<PanelCard>
			<PanelCardButton onActivate={() => onJump?.(trace.id)}>
				<div className="flex items-center gap-1.5">
					<ScanSearch
						className="size-3 shrink-0 text-violet-600 dark:text-violet-400"
						aria-hidden
					/>
					<span className="font-medium text-xs text-muted-foreground uppercase tracking-wider tabular-nums">
						{t("annotations.pageLabel", { page: trace.page })}
					</span>
				</div>
				<p className="mt-1.5 line-clamp-2 text-sm text-foreground leading-relaxed">
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
			</PanelCardButton>
			{onDelete || wikiTarget ? (
				<PanelCardActions>
					{linkOpts ? (
						<>
							<QuietIconButton
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
							</QuietIconButton>
							<QuietIconButton
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
								<span className="font-mono text-caption leading-none">![[</span>
							</QuietIconButton>
						</>
					) : null}
					{onDelete ? (
						<QuietIconButton
							tone="destructive"
							aria-label={t("annotations.deleteVisual")}
							onClick={() => onDelete(trace.id)}
						>
							<Trash2 className="size-3.5" />
						</QuietIconButton>
					) : null}
				</PanelCardActions>
			) : null}
		</PanelCard>
	);
}
