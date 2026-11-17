import {
	ArrowUpRight,
	BookCheck,
	ChevronDown,
	Import,
	Loader2,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { CitationImportPopover } from "@/components/viewer/citation-import-menu";
import { PreviewArrow } from "@/components/viewer/pdf/cards/preview-arrow";
import { PDF_FLOAT_CARD } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { computePreviewPlacement } from "@/components/viewer/pdf/preview-placement";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { useVaultStore } from "@/hooks/use-app-stores";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { loadPaperMetadata } from "@/lib/paper/load-meta";
import type { Citation } from "@/lib/paper/refs";
import {
	citationExternalUrl,
	citationImportIdentifier,
} from "@/lib/paper/refs";
import type { PaperMetadata } from "@/lib/paper/types";
import { joinVaultPath } from "@/lib/vault/path";

const CARD_WIDTH = 300;
const CARD_ESTIMATED_HEIGHT = 110;
/** Cap stacked range previews so a wide `1-30` cluster stays usable. */
const LIST_MAX_HEIGHT = 280;

export type CitationPreviewImportMenu = {
	folders: string[];
	lastImportParentDir: string;
	importingId: string | null;
	onImport: (citation: Citation, folder: string) => void;
	/** Lets the hover card stay open while the folder picker is up. */
	onOpenChange: (open: boolean) => void;
	/**
	 * True for remote papers: every citation row shows an import button that
	 * imports the current paper, because individual reference metadata is not
	 * available until the paper is in the library.
	 */
	remotePaper?: boolean;
};

function citationMetaParts(citation: Citation): string[] {
	const m = citation.metadata;
	return [
		m.authors?.length
			? m.authors.length > 1
				? `${m.authors[0]} et al.`
				: m.authors[0]
			: null,
		m.year != null ? String(m.year) : null,
		m.venue || null,
	].filter(Boolean) as string[];
}

function CitationPreviewRow({
	citation,
	importMenu,
	showDivider,
	expanded,
	onExpand,
}: {
	citation: Citation;
	importMenu?: CitationPreviewImportMenu;
	showDivider: boolean;
	expanded: boolean;
	onExpand: () => void;
}) {
	const { t } = useTranslation("viewer");
	const vaultPath = useVaultStore((state) => state.vaultPath);
	const [local, setLocal] = useState<PaperMetadata | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset cached details when the library identity changes.
	useEffect(() => setLocal(null), [vaultPath, citation.localMatch?.paperPath]);
	const titleRef = useRef<HTMLParagraphElement>(null);
	const metaRef = useRef<HTMLParagraphElement>(null);
	const [truncated, setTruncated] = useState(false);
	const reducedMotion = useReducedMotion();
	const m = {
		...citation.metadata,
		...(local
			? {
					title: local.title || citation.metadata.title,
					authors: local.authors.length
						? local.authors
						: citation.metadata.authors,
					year: local.year ?? citation.metadata.year,
					venue: local.publication || citation.metadata.venue,
					doi: local.doi || citation.metadata.doi,
					arxivId: local.arxiv_id || citation.metadata.arxivId,
				}
			: {}),
	};
	useEffect(() => {
		if (!expanded || !vaultPath || !citation.localMatch) return;
		let cancelled = false;
		void loadPaperMetadata(
			joinVaultPath(vaultPath, citation.localMatch.paperPath),
			vaultPath,
		)
			.then((record) => {
				if (!cancelled) setLocal(record);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [expanded, vaultPath, citation.localMatch]);
	useLayoutEffect(() => {
		if (expanded) return;
		const measure = () =>
			setTruncated(
				[titleRef.current, metaRef.current].some(
					(el) =>
						el &&
						(el.scrollHeight > el.clientHeight + 1 ||
							el.scrollWidth > el.clientWidth + 1),
				),
			);
		measure();
		const observer = new ResizeObserver(measure);
		if (titleRef.current) observer.observe(titleRef.current);
		if (metaRef.current) observer.observe(metaRef.current);
		return () => observer.disconnect();
	}, [expanded]);
	const expandable =
		truncated ||
		(m.authors?.length ?? 0) > 1 ||
		Boolean(m.doi || m.arxivId || citation.localMatch);
	const metaParts = citationMetaParts(citation);
	const inLibrary = Boolean(citation.localMatch);
	const importable =
		!inLibrary &&
		(citationImportIdentifier(citation) != null || importMenu?.remotePaper);
	const link = citationExternalUrl(citation);
	const importing = importMenu?.importingId === citation.id;
	// Numbered refs show `[7]`. Unnumbered bib keys become `cite-…` ids with no
	// spaces; `shrink-0` lets that string paint past the 300px card.
	const label = citation.display || t("references.previewLabel");

	const importIcon = importing ? (
		<Loader2 className="size-3.5 animate-spin" aria-hidden />
	) : (
		<Import className="size-3.5" aria-hidden />
	);

	return (
		<div
			className={showDivider ? "border-border/60 border-t pt-2.5" : undefined}
		>
			<div className="flex items-start justify-between gap-2">
				<span className="min-w-0 break-all font-medium text-caption text-muted-foreground tabular-nums">
					{label}
				</span>
				<span className="flex shrink-0 items-center gap-1">
					{inLibrary ? (
						<span className="flex items-center gap-1 text-caption text-emerald-600 dark:text-emerald-500">
							<BookCheck className="size-3.5" aria-hidden />
							{t("references.inLibrary")}
						</span>
					) : importable && importMenu ? (
						<CitationImportPopover
							citationId={citation.id}
							folders={importMenu.folders}
							lastImportParentDir={importMenu.lastImportParentDir}
							importing={importing}
							onImport={(folder) => importMenu.onImport(citation, folder)}
							onOpenChange={importMenu.onOpenChange}
						>
							<button
								type="button"
								className="inline-flex min-h-6 items-center gap-1 rounded p-0.5 text-caption text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
								aria-label={t("references.import")}
								disabled={importing}
								onClick={(e) => e.stopPropagation()}
							>
								{importIcon}
								{t("references.previewImport")}
							</button>
						</CitationImportPopover>
					) : null}
					{link ? (
						<button
							type="button"
							className="inline-flex min-h-6 items-center gap-1 rounded p-0.5 text-caption text-muted-foreground transition-colors hover:text-foreground"
							aria-label={t("references.openLink")}
							onClick={(e) => {
								e.stopPropagation();
								openExternalUrl(link);
							}}
						>
							<ArrowUpRight className="size-3.5" aria-hidden />
							{t("references.openLink")}
						</button>
					) : null}
				</span>
			</div>
			<p
				ref={titleRef}
				className={cn(
					"mt-1 text-sm leading-snug text-foreground",
					!expanded && "line-clamp-2",
				)}
			>
				{m.title ?? citation.raw ?? citation.rawKey ?? citation.id}
			</p>
			{!expanded && metaParts.length ? (
				<p
					ref={metaRef}
					className="mt-0.5 truncate text-caption text-muted-foreground"
				>
					{metaParts.join(" · ")}
				</p>
			) : null}
			<motion.div
				initial={false}
				animate={{ height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0 }}
				transition={{ duration: reducedMotion ? 0 : 0.18 }}
				className="overflow-hidden"
			>
				{expanded ? (
					<div className="space-y-2 pt-2 text-caption leading-relaxed text-muted-foreground">
						{m.authors?.length ? <p>{m.authors.join(", ")}</p> : null}
						{m.venue || m.year ? (
							<p>{[m.venue, m.year].filter(Boolean).join(" · ")}</p>
						) : null}
						{local ? (
							<>
								{[
									local.volume,
									local.issue ? `(${local.issue})` : null,
									local.pages,
								].filter(Boolean).length ? (
									<p>
										{[
											local.volume,
											local.issue ? `(${local.issue})` : null,
											local.pages,
										]
											.filter(Boolean)
											.join(" · ")}
									</p>
								) : null}
								{local.publisher ? <p>{local.publisher}</p> : null}
								{local.abstract ? <p>{local.abstract}</p> : null}
								{local.citation_count != null ? (
									<p>
										{t("references.citationCount", {
											count: local.citation_count,
										})}
									</p>
								) : null}
								{local.tags.length ? (
									<p>
										{local.tags
											.map((tag) => (typeof tag === "string" ? tag : tag.name))
											.join(" · ")}
									</p>
								) : null}
							</>
						) : null}
						{m.doi ? (
							<button
								type="button"
								className="block break-all text-left text-primary hover:underline"
								onClick={() => openExternalUrl(`https://doi.org/${m.doi}`)}
							>
								DOI: {m.doi}
							</button>
						) : null}
						{m.arxivId ? (
							<button
								type="button"
								className="block break-all text-left text-primary hover:underline"
								onClick={() =>
									openExternalUrl(`https://arxiv.org/abs/${m.arxivId}`)
								}
							>
								arXiv: {m.arxivId}
							</button>
						) : null}
					</div>
				) : null}
			</motion.div>
			{expandable && !expanded ? (
				<button
					type="button"
					className="mt-1 flex min-h-6 w-full items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline focus-visible:outline-ring"
					aria-label={t("references.expandPreview")}
					aria-expanded={false}
					onPointerEnter={onExpand}
					onFocus={onExpand}
					onClick={onExpand}
				>
					<ChevronDown className="size-3.5" aria-hidden />
				</button>
			) : null}
		</div>
	);
}

/**
 * Hover card for an in-text citation link: the reference(s) it points at.
 * A single hyperref hit is one row; ACS ranges like `14-18` list every index
 * in the expanded cluster. Only mounted when at least one match exists.
 */
export function PdfCitationPreview({
	screen,
	matched,
	importMenu,
	onPointerEnter,
	onPointerLeave,
}: {
	screen: ScreenPoint;
	matched: Citation[];
	importMenu?: CitationPreviewImportMenu;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
}) {
	const { t } = useTranslation("viewer");
	const rootRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [contentHeight, setContentHeight] = useState(0);
	const [viewport, setViewport] = useState(() => ({
		width: typeof window === "undefined" ? 1200 : window.innerWidth,
		height: typeof window === "undefined" ? 800 : window.innerHeight,
	}));
	const groupKey = matched.map((c) => c.id).join("\0");
	// biome-ignore lint/correctness/useExhaustiveDependencies: a different group resets expansion.
	useEffect(() => setExpandedId(null), [groupKey]);
	useLayoutEffect(() => {
		const node = contentRef.current;
		if (!node) return;
		const observer = new ResizeObserver(() =>
			setContentHeight(node.getBoundingClientRect().height),
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const resize = () =>
			setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	useEffect(() => {
		if (!expandedId) return;
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			setExpandedId(null);
		};
		window.addEventListener("keydown", handleEscape, true);
		return () => window.removeEventListener("keydown", handleEscape, true);
	}, [expandedId]);
	const viewportWidth = viewport.width;
	const viewportHeight = viewport.height;
	const cardEstimatedHeight = contentHeight
		? Math.min(contentHeight, matched.length > 1 ? LIST_MAX_HEIGHT : 500) + 24
		: matched.length <= 1
			? CARD_ESTIMATED_HEIGHT
			: Math.min(LIST_MAX_HEIGHT, 28 + matched.length * 72);

	const { placement, left, top, bottom, arrowLeft, maxContentHeight } =
		computePreviewPlacement({
			screen,
			cardWidth: Math.min(CARD_WIDTH, viewportWidth - 24),
			cardChromeHeight: 24,
			cardEstimatedHeight,
			viewportWidth,
			viewportHeight,
		});

	const maxListHeight = Math.min(LIST_MAX_HEIGHT, maxContentHeight);

	// Mount under an existing pointer skips pointerenter — re-arm sticky hover.
	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		if (el.matches(":hover")) onPointerEnter();
	}, [onPointerEnter]);

	const handlePointerLeave = (e: ReactPointerEvent<HTMLDivElement>) => {
		const next = e.relatedTarget;
		if (next instanceof Node && e.currentTarget.contains(next)) return;
		onPointerLeave();
	};

	return (
		<div
			ref={rootRef}
			role="dialog"
			aria-label={t("references.previewLabel")}
			data-pdf-chrome
			className={cn(
				"fixed z-50 w-[300px] p-3",
				PDF_FLOAT_CARD,
				placement === "bottom" ? "origin-top" : "origin-bottom",
				"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150 motion-reduce:animate-none",
			)}
			style={{
				left,
				top,
				bottom,
				width: Math.min(CARD_WIDTH, viewportWidth - 24),
			}}
			onPointerEnter={onPointerEnter}
			onPointerLeave={handlePointerLeave}
		>
			<PreviewArrow placement={placement} left={arrowLeft} />
			<div
				className="overflow-y-auto overscroll-contain"
				style={{
					maxHeight: matched.length > 1 ? maxListHeight : maxContentHeight,
				}}
			>
				<div ref={contentRef} className="flex flex-col gap-2.5">
					{matched.map((citation, index) => (
						<CitationPreviewRow
							key={citation.id}
							citation={citation}
							importMenu={importMenu}
							showDivider={index > 0}
							expanded={expandedId === citation.id}
							onExpand={() => setExpandedId(citation.id)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
