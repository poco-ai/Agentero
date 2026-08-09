import {
	ArrowUpRight,
	BookCheck,
	BookMarked,
	Check,
	FolderPlus,
	Import,
	Loader2,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { PaneHeader } from "@/components/shell/pane-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useVaultStore } from "@/hooks/use-app-stores";
import { usePapersOrgFolders } from "@/hooks/use-papers-org-folders";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { resolvePapersParentDir } from "@/lib/paper/detect";
import { lookupSubmit } from "@/lib/paper/import-actions";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import {
	type Citation,
	type CiteSidecar,
	citationImportIdentifier,
	loadPaperRefsAuto,
	paperRefsParse,
} from "@/lib/paper/refs";
import { joinVaultPath } from "@/lib/vault/path";
import { openPaper } from "@/lib/workspace/actions";

type ReferencesPanelProps = {
	vaultPath: string | null;
	/** Vault-relative paper folder of the active document; null = not a paper. */
	paperPath: string | null;
	className?: string;
};

/** Best external link for a citation: url → DOI resolver → arXiv abs page. */
function externalUrl(citation: Citation): string | null {
	const { url, doi, arxivId } = citation.metadata;
	if (url?.trim()) return url.trim();
	if (doi?.trim()) return `https://doi.org/${doi.trim()}`;
	if (arxivId?.trim()) return `https://arxiv.org/abs/${arxivId.trim()}`;
	return null;
}

function citationMatchesFilter(citation: Citation, needle: string): boolean {
	const m = citation.metadata;
	const haystack = [
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
	return haystack.includes(needle);
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
}: ReferencesPanelProps) {
	const { t } = useTranslation("viewer");
	const [sidecar, setSidecar] = useState<CiteSidecar | null>(null);
	const [loading, setLoading] = useState(false);
	const [parsing, setParsing] = useState(false);
	const [filter, setFilter] = useState("");
	const [importingId, setImportingId] = useState<string | null>(null);
	const paperPathRef = useRef(paperPath);
	paperPathRef.current = paperPath;
	const listRef = useRef<HTMLDivElement>(null);

	const tree = useVaultStore((s) => s.tree);
	const folders = usePapersOrgFolders(vaultPath, tree);
	const [lastImportParentDir, setLastImportParentDir] = useState(() =>
		vaultPath && paperPath
			? resolvePapersParentDir(vaultPath, paperPath, tree)
			: currentLookupParentDir(),
	);
	useEffect(() => {
		setLastImportParentDir(
			vaultPath && paperPath
				? resolvePapersParentDir(vaultPath, paperPath, tree)
				: currentLookupParentDir(),
		);
	}, [vaultPath, paperPath, tree]);

	useEffect(() => {
		setSidecar(null);
		setFilter("");
		if (!vaultPath || !paperPath) return;
		let cancelled = false;
		setLoading(true);
		loadPaperRefsAuto(vaultPath, paperPath)
			.then((s) => {
				if (!cancelled) setSidecar(s);
			})
			.catch(() => {
				if (!cancelled) setSidecar(null);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [vaultPath, paperPath]);

	const runParse = useCallback(
		async (force: boolean) => {
			if (!vaultPath || !paperPath) return;
			setParsing(true);
			try {
				const parsed = await paperRefsParse(vaultPath, paperPath, force);
				if (paperPathRef.current === paperPath) setSidecar(parsed);
			} catch (error) {
				notifyError(t("references.parseFailed"), {
					description: error instanceof Error ? error.message : String(error),
				});
			} finally {
				setParsing(false);
			}
		},
		[vaultPath, paperPath, t],
	);

	const importCitation = useCallback(
		async (citation: Citation, parentDir: string) => {
			const identifier = citationImportIdentifier(citation);
			if (!identifier || !vaultPath || !paperPath) return;
			setImportingId(citation.id);
			setLastImportParentDir(parentDir);
			const origin = paperPath;
			try {
				await lookupSubmit([identifier], {
					openImported: false,
					parentDir,
					onComplete: async () => {
						try {
							const parsed = await paperRefsParse(vaultPath, origin, true);
							if (paperPathRef.current === origin) setSidecar(parsed);
						} catch (error) {
							notifyError(t("references.importFailed"), {
								description:
									error instanceof Error ? error.message : String(error),
							});
						}
					},
				});
			} catch (error) {
				notifyError(t("references.importFailed"), {
					description: error instanceof Error ? error.message : String(error),
				});
			} finally {
				setImportingId(null);
			}
		},
		[vaultPath, paperPath, t],
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
	// Ordinal comes from the unfiltered list, so carry it through the filter.
	const rows = citations.map((citation, index) => ({
		citation,
		ordinal: index + 1,
	}));
	const visible = needle
		? rows.filter((row) => citationMatchesFilter(row.citation, needle))
		: rows;

	return (
		<section
			className={cn(
				"flex h-full min-h-0 flex-col overflow-hidden bg-background",
				className,
			)}
			aria-label={t("references.panelAria")}
		>
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

			{!paperPath ? (
				<EmptyState text={t("references.noPaper")} />
			) : loading ? (
				<div className="flex min-h-0 flex-1 items-center justify-center">
					<Loader2
						className="size-4 animate-spin text-muted-foreground"
						aria-hidden
					/>
				</div>
			) : !sidecar || citations.length === 0 ? (
				<EmptyState
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
				</EmptyState>
			) : (
				<>
					<div className="border-b px-2 py-1.5">
						<Input
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder={t("references.filterPlaceholder")}
							className="h-7 text-xs"
							spellCheck={false}
						/>
					</div>
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
			)}
		</section>
	);
}

function EmptyState({
	text,
	children,
}: {
	text: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
			<div className="flex size-12 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground">
				<BookMarked className="size-5" aria-hidden />
			</div>
			<p className="max-w-[15rem] text-muted-foreground text-xs leading-relaxed">
				{text}
			</p>
			{children}
		</div>
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
				<span className="shrink-0 font-medium text-[10px] text-muted-foreground tabular-nums">
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
					"mt-1 line-clamp-2 text-[13px] leading-snug",
					m.title ? "text-foreground" : "text-muted-foreground",
				)}
			>
				{m.title ?? citation.raw ?? citation.rawKey ?? citation.id}
			</p>
			{metaParts.length > 0 ? (
				<p className="mt-0.5 truncate text-[11px] text-muted-foreground">
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
	const [folderMenuOpen, setFolderMenuOpen] = useState(false);
	const [newFolder, setNewFolder] = useState("");
	const matched = Boolean(citation.localMatch);
	const link = externalUrl(citation);
	const importable = !matched && citationImportIdentifier(citation) != null;

	const typed = newFolder.trim();
	const normalizedNew = typed ? normalizeNewFolderInput(typed) : "";
	const newValid = Boolean(
		normalizedNew && isValidPapersParentDir(normalizedNew),
	);

	const handleSelectFolder = (folder: string) => {
		setFolderMenuOpen(false);
		setNewFolder("");
		onImport(citation, folder);
	};

	const activate = () => {
		if (matched) {
			onOpenMatched(citation);
		}
	};

	return (
		<div className="group relative rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-border/60 hover:bg-muted/40">
			{matched ? (
				// biome-ignore lint/a11y/useSemanticElements: role=button wrapper for card activation
				<div
					role="button"
					tabIndex={0}
					className="block w-full cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={activate}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							activate();
						}
					}}
				>
					<ReferenceCardBody citation={citation} ordinal={ordinal} />
				</div>
			) : (
				<div className="block w-full rounded-md text-left">
					<ReferenceCardBody citation={citation} ordinal={ordinal} />
				</div>
			)}
			<div className="absolute top-2 right-2 flex items-center gap-0.5 rounded-lg bg-background/80 p-0.5 opacity-0 shadow-sm ring-1 ring-border/60 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
				{importable ? (
					<Popover open={folderMenuOpen} onOpenChange={setFolderMenuOpen}>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="size-6 text-muted-foreground hover:text-foreground"
								aria-label={t("references.import")}
								disabled={importing}
							>
								{importing ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Import className="size-3.5" />
								)}
							</Button>
						</PopoverTrigger>
						<PopoverContent
							align="end"
							side="bottom"
							sideOffset={4}
							className="w-56 p-2"
						>
							<div className="space-y-2">
								<p className="font-medium text-xs text-foreground">
									{t("references.importToFolder")}
								</p>
								<ScrollArea className="h-40 rounded-md border">
									<div className="space-y-0.5 p-1">
										{folders.map((folder) => {
											const active = folder === lastImportParentDir;
											return (
												<button
													key={folder}
													type="button"
													disabled={importing}
													className={cn(
														"flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
														active && "bg-muted",
													)}
													onClick={() => handleSelectFolder(folder)}
												>
													<span className="flex-1 truncate font-mono">
														{folder}
													</span>
													{active ? (
														<Check className="size-3 shrink-0 text-primary" />
													) : null}
												</button>
											);
										})}
									</div>
								</ScrollArea>
								<div className="space-y-1">
									<Label
										htmlFor={`ref-new-folder-${citation.id}`}
										className="text-[10px] text-muted-foreground"
									>
										{t("references.newFolder")}
									</Label>
									<div className="relative">
										<FolderPlus className="-translate-y-1/2 absolute top-1/2 left-2 size-3 text-muted-foreground" />
										<Input
											id={`ref-new-folder-${citation.id}`}
											value={newFolder}
											onChange={(e) => setNewFolder(e.target.value)}
											placeholder={t("references.newFolderHint")}
											disabled={importing}
											spellCheck={false}
											className="h-7 pl-6 text-xs font-mono"
											onKeyDown={(e) => {
												if (e.key === "Enter" && newValid) {
													e.preventDefault();
													handleSelectFolder(normalizedNew);
												}
											}}
										/>
									</div>
									{typed && !newValid ? (
										<p className="text-[10px] text-destructive">
											{t("references.invalidFolderPath")}
										</p>
									) : null}
								</div>
							</div>
						</PopoverContent>
					</Popover>
				) : null}
				{link ? (
					<TooltipProvider delayDuration={250}>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="size-6 text-muted-foreground hover:text-foreground"
									aria-label={t("references.openLink")}
									onClick={() => openExternalUrl(link)}
								>
									<ArrowUpRight className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("references.openLink")}
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				) : null}
			</div>
		</div>
	);
}

function normalizeNewFolderInput(input: string): string {
	const trimmed = input
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!trimmed) return "";
	if (trimmed === "papers" || trimmed.startsWith("papers/")) return trimmed;
	return `papers/${trimmed}`;
}

function isValidPapersParentDir(path: string): boolean {
	if (!path) return false;
	if (path !== "papers" && !path.startsWith("papers/")) return false;
	return path
		.split("/")
		.every((segment) => segment && segment !== "." && segment !== "..");
}
