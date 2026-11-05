import {
	ArrowUpRight,
	BookCheck,
	BookMarked,
	Import,
	Loader2,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PaneHeader } from "@/components/shell/pane-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QuietIconButton } from "@/components/ui/quiet-icon-button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { CitationImportPopover } from "@/components/viewer/citation-import-menu";
import {
	PanelCard,
	PanelCardActions,
	PanelCardButton,
	PanelEmptyState,
} from "@/components/viewer/panels/panel-primitives";
import { useCitationImport } from "@/hooks/use-citation-import";
import { usePaperRefsSidecar } from "@/hooks/use-paper-refs-sidecar";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import {
	type Citation,
	citationExternalUrl,
	citationImportIdentifier,
	paperRefsParse,
} from "@/lib/paper/refs";
import { joinVaultPath } from "@/lib/vault/path";
import { openPaper } from "@/lib/workspace/actions";

type ReferencesPanelProps = {
	vaultPath: string | null;
	/** Vault-relative paper folder of the active document; null = not a paper. */
	paperPath: string | null;
	className?: string;
	/** Hide the pane header and filter input for use inside a floating PDF panel. */
	compact?: boolean;
};

/**
 * Lowercase filter haystack for one citation. Joins `citation.raw` (the full
 * BibTeX/bbl source), so build it once per sidecar instead of per keystroke.
 */
function citationFilterHaystack(citation: Citation): string {
	const m = citation.metadata;
	return [
		citation.display,
		citation.rawKey,
		citation.raw,
		m.title,
		m.venue,
		m.doi,
		m.arxivId,
		m.year != null ? String(m.year) : undefined,
		...(m.authors ?? []),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

/**
 * Right-sidebar reference list for the active paper: compact citation cards
 * from the `agentero-cite.json` sidecar (parse on demand, filter, open
 * matched library papers, import unmatched ones via the magic-wand pipeline).
 */
export function ReferencesPanel({
	vaultPath,
	paperPath,
	className,
	compact,
}: ReferencesPanelProps) {
	const { t } = useTranslation("viewer");
	const { sidecar, loading, setSidecar } = usePaperRefsSidecar(
		vaultPath,
		paperPath,
	);
	const [parsing, setParsing] = useState(false);
	const [filter, setFilter] = useState("");
	const paperPathRef = useRef(paperPath);
	paperPathRef.current = paperPath;
	const listRef = useRef<HTMLDivElement>(null);

	const { folders, lastImportParentDir, importingId, importCitation } =
		useCitationImport(vaultPath, paperPath, setSidecar);

	// biome-ignore lint/correctness/useExhaustiveDependencies: paperPath is the effect trigger, not a value read inside the effect.
	useEffect(() => {
		setFilter("");
	}, [paperPath]);

	const runParse = useCallback(
		async (force: boolean) => {
			if (!vaultPath || !paperPath) return;
			setParsing(true);
			try {
				const parsed = await paperRefsParse(vaultPath, paperPath, force);
				if (paperPathRef.current === paperPath) setSidecar(parsed);
			} catch (error) {
				notifyError(t("references.parseFailed"), {
					description: errorText(error),
				});
			} finally {
				setParsing(false);
			}
		},
		[vaultPath, paperPath, t, setSidecar],
	);

	const openMatched = useCallback(
		(citation: Citation) => {
			if (!vaultPath || !citation.localMatch) return;
			openPaper(joinVaultPath(vaultPath, citation.localMatch.paperPath));
		},
		[vaultPath],
	);

	const citations = sidecar?.citations ?? [];
	const needle = filter.trim().toLowerCase();
	// Haystacks / ordinals only change with the sidecar; typing in the filter
	// reuses them and just runs `includes` over the precomputed strings.
	const haystacks = useMemo(
		() => citations.map(citationFilterHaystack),
		[citations],
	);
	// Ordinal comes from the unfiltered list, so carry it through the filter.
	const rows = useMemo(
		() =>
			citations.map((citation, index) => ({ citation, ordinal: index + 1 })),
		[citations],
	);
	const visible = needle
		? rows.filter((_, index) => haystacks[index].includes(needle))
		: rows;

	const listBody = !paperPath ? (
		<PanelEmptyState
			icon={<BookMarked className="size-5" aria-hidden />}
			text={t("references.noPaper")}
		/>
	) : loading ? (
		<div className="flex min-h-0 flex-1 items-center justify-center">
			<Loader2
				className="size-4 animate-spin text-muted-foreground"
				aria-hidden
			/>
		</div>
	) : !sidecar || citations.length === 0 ? (
		<PanelEmptyState
			icon={<BookMarked className="size-5" aria-hidden />}
			text={sidecar ? t("references.emptyParsed") : t("references.empty")}
		>
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={parsing}
				onClick={() => void runParse(Boolean(sidecar))}
			>
				{parsing ? (
					<Loader2 className="size-3.5 animate-spin" aria-hidden />
				) : null}
				{t("references.parse")}
			</Button>
		</PanelEmptyState>
	) : (
		<>
			{compact ? null : (
				<div className="border-b px-2 py-1.5">
					<Input
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder={t("references.filterPlaceholder")}
						className="h-7 text-sm"
						spellCheck={false}
					/>
				</div>
			)}
			<div
				ref={listRef}
				className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-2"
			>
				{visible.length === 0 ? (
					<p className="px-2 py-6 text-center text-muted-foreground text-xs">
						{t("references.noFilterMatch")}
					</p>
				) : (
					<ul className="space-y-1">
						{visible.map(({ citation, ordinal }) => (
							<li key={citation.id}>
								<CitationCard
									citation={citation}
									ordinal={ordinal}
									importing={importingId === citation.id}
									folders={folders}
									lastImportParentDir={lastImportParentDir}
									onOpenMatched={openMatched}
									onImport={importCitation}
								/>
							</li>
						))}
					</ul>
				)}
			</div>
		</>
	);

	return (
		<section
			className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}
			aria-label={t("references.panelAria")}
		>
			{compact ? null : (
				<PaneHeader
					trailing={
						paperPath && sidecar ? (
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="size-6 text-muted-foreground hover:text-foreground"
								aria-label={t("references.reparse")}
								disabled={parsing}
								onClick={() => void runParse(true)}
							>
								<RefreshCw
									className={cn("size-3.5", parsing && "animate-spin")}
								/>
							</Button>
						) : null
					}
				>
					<BookMarked className="size-4 text-muted-foreground" aria-hidden />
					<span className="font-medium text-sm">{t("references.title")}</span>
				</PaneHeader>
			)}

			{listBody}
		</section>
	);
}

function ReferenceCardBody({
	citation,
	ordinal,
}: {
	citation: Citation;
	ordinal: number;
}) {
	const { t } = useTranslation("viewer");
	const m = citation.metadata;
	const matched = Boolean(citation.localMatch);

	const metaParts = [
		m.authors?.length
			? m.authors.length > 1
				? `${m.authors[0]} et al.`
				: m.authors[0]
			: null,
		m.year != null ? String(m.year) : null,
		m.venue || null,
	].filter(Boolean) as string[];

	return (
		<>
			<div className="flex items-center gap-1.5">
				<span className="shrink-0 font-medium text-caption text-muted-foreground tabular-nums">
					{citation.display ?? `[${ordinal}]`}
				</span>
				{matched ? (
					<BookCheck
						className="size-3 shrink-0 text-emerald-600 dark:text-emerald-500"
						aria-label={t("references.inLibrary")}
					/>
				) : null}
			</div>
			<p
				className={cn(
					"mt-1 line-clamp-2 text-sm leading-snug",
					m.title ? "text-foreground" : "text-muted-foreground",
				)}
			>
				{m.title ?? citation.raw ?? citation.rawKey ?? citation.id}
			</p>
			{metaParts.length > 0 ? (
				<p className="mt-0.5 truncate text-xs text-muted-foreground">
					{metaParts.join(" · ")}
				</p>
			) : null}
		</>
	);
}

function CitationCard({
	citation,
	ordinal,
	importing,
	folders,
	lastImportParentDir,
	onOpenMatched,
	onImport,
}: {
	citation: Citation;
	/** 1-based position in the full (unfiltered) sidecar list. */
	ordinal: number;
	importing: boolean;
	folders: string[];
	lastImportParentDir: string;
	onOpenMatched: (citation: Citation) => void;
	onImport: (citation: Citation, parentDir: string) => void;
}) {
	const { t } = useTranslation("viewer");
	const matched = Boolean(citation.localMatch);
	const link = citationExternalUrl(citation);
	const importable = !matched && citationImportIdentifier(citation) != null;

	const activate = () => {
		if (matched) {
			onOpenMatched(citation);
		}
	};

	return (
		<PanelCard>
			{matched ? (
				<PanelCardButton onActivate={activate}>
					<ReferenceCardBody citation={citation} ordinal={ordinal} />
				</PanelCardButton>
			) : (
				<div className="block w-full rounded-md text-left">
					<ReferenceCardBody citation={citation} ordinal={ordinal} />
				</div>
			)}
			<PanelCardActions>
				{importable ? (
					<CitationImportPopover
						citationId={citation.id}
						folders={folders}
						lastImportParentDir={lastImportParentDir}
						importing={importing}
						onImport={(folder) => onImport(citation, folder)}
					>
						<QuietIconButton
							aria-label={t("references.import")}
							disabled={importing}
						>
							{importing ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Import className="size-3.5" />
							)}
						</QuietIconButton>
					</CitationImportPopover>
				) : null}
				{link ? (
					<TooltipProvider delayDuration={250}>
						<Tooltip>
							<TooltipTrigger asChild>
								<QuietIconButton
									aria-label={t("references.openLink")}
									onClick={() => openExternalUrl(link)}
								>
									<ArrowUpRight className="size-3.5" />
								</QuietIconButton>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("references.openLink")}
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				) : null}
			</PanelCardActions>
		</PanelCard>
	);
}
