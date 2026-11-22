/**
 * Select AlphaXiv library papers, then import them through the identifier pipeline.
 */

import { Check, Import, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlphaXivFolderIcon } from "@/components/dialogs/alphaxiv-folder-icon";
import { AlphaXivIcon } from "@/components/icons/paper-service-icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useLibraryStore } from "@/hooks/use-app-stores";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import i18n from "@/i18n";
import type { AlphaXivFolder, AlphaXivFolderPaper } from "@/lib/core/bindings";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { type ApiError, callApi } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { hasSecret } from "@/lib/core/secret-mask";
import { isTauri } from "@/lib/core/tauri";
import {
	type AlphaXivImportPlanItem,
	type AlphaXivImportSource,
	alphaXivPaperId,
	alphaXivRowKey,
	arxivMatchKey,
	formatAlphaXivAddedAt,
	importAlphaXivPlan,
	libraryArxivIds,
	planAlphaXivImport,
} from "@/lib/paper/alphaxiv-import";
import { libraryStore } from "@/lib/paper/library-store";
import { loadSettings } from "@/lib/settings";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { openPaper } from "@/lib/workspace/actions";

type FolderNode = { folder: AlphaXivFolder; depth: number };

function folderNodes(folders: readonly AlphaXivFolder[]): FolderNode[] {
	const ids = new Set(folders.map((folder) => folder.id));
	const byParent = new Map<string, AlphaXivFolder[]>();
	for (const folder of folders) {
		const parent =
			folder.parentId && ids.has(folder.parentId) ? folder.parentId : "";
		const list = byParent.get(parent) ?? [];
		list.push(folder);
		byParent.set(parent, list);
	}
	for (const list of byParent.values()) {
		list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
	}
	const out: FolderNode[] = [];
	const walk = (parent: string, depth: number, stack: Set<string>) => {
		for (const folder of byParent.get(parent) ?? []) {
			if (stack.has(folder.id)) continue;
			out.push({ folder, depth });
			stack.add(folder.id);
			walk(folder.id, depth + 1, stack);
			stack.delete(folder.id);
		}
	};
	walk("", 0, new Set());
	return out;
}

function paperId(paper: AlphaXivFolderPaper, index: number): string {
	return alphaXivPaperId({
		paperGroupId: paper.paperGroupId,
		arxivId: paper.arxivId,
		canonicalId: paper.canonicalId,
		title: paper.title,
		index,
	});
}

function rowKey(
	folderId: string,
	paper: AlphaXivFolderPaper,
	index: number,
): string {
	return alphaXivRowKey(folderId, paperId(paper, index));
}

function alreadyInLibrary(
	paper: AlphaXivFolderPaper,
	inVault: ReadonlySet<string>,
): boolean {
	const key = arxivMatchKey(paper.arxivId);
	return key.length > 0 && inVault.has(key);
}

function defaultSelected(
	folders: readonly AlphaXivFolder[],
	inVault: ReadonlySet<string>,
): Set<string> {
	const selected = new Set<string>();
	for (const folder of folders) {
		folder.papers.forEach((paper, index) => {
			if (!paper.importable || alreadyInLibrary(paper, inVault)) return;
			selected.add(rowKey(folder.id, paper, index));
		});
	}
	return selected;
}

function folderTitle(folder: AlphaXivFolder, language: string): string {
	const translate = i18n.getFixedT(language, "sidebar");
	switch (folder.folderType.trim()) {
		case "default-publications":
			return translate("alphaxivImport.folders.default-publications");
		case "default-to-read":
			return translate("alphaxivImport.folders.default-to-read");
		case "default-reading":
			return translate("alphaxivImport.folders.default-reading");
		case "default-completed":
			return translate("alphaxivImport.folders.default-completed");
		default: {
			const name = folder.name.trim();
			return name || translate("alphaxivImport.untitledFolder");
		}
	}
}

function selectedSources(
	folders: readonly AlphaXivFolder[],
	selected: ReadonlySet<string>,
	language: string,
): AlphaXivImportSource[] {
	const rows: AlphaXivImportSource[] = [];
	for (const folder of folders) {
		folder.papers.forEach((paper, index) => {
			if (!selected.has(rowKey(folder.id, paper, index))) return;
			rows.push({
				folderName: folderTitle(folder, language),
				arxivId: paper.arxivId,
				pdfUrl: paper.pdfUrl,
				title: paper.title,
				importable: paper.importable,
			});
		});
	}
	return rows;
}

function paperLine(paper: AlphaXivFolderPaper): string {
	const authors = paper.authors.map((name) => name.trim()).filter(Boolean);
	const authorText =
		authors.length > 3
			? `${authors.slice(0, 3).join(", ")} +${authors.length - 3}`
			: authors.join(", ");
	return [authorText, paper.arxivId, formatAlphaXivAddedAt(paper.addedAt)]
		.filter(Boolean)
		.join(" · ");
}

function isKeyMissing(error: unknown): boolean {
	return (error as ApiError | undefined)?.code === "alphaxiv_key_missing";
}

const FOLDER_SKELETON_WIDTHS = ["70%", "52%", "84%", "46%", "64%", "40%"];
const PAPER_SKELETON_WIDTHS = ["88%", "72%", "94%", "61%", "80%", "68%"];

/** Same two-pane geometry as the loaded library, so the dialog does not grow in. */
function AlphaXivImportSkeleton({ label }: { label: string }) {
	return (
		<div aria-busy="true" role="status">
			<p className="sr-only">{label}</p>
			<div className="grid min-h-0 gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
				<div className="h-80 space-y-0.5 rounded-md border p-1">
					{FOLDER_SKELETON_WIDTHS.map((width) => (
						<div
							key={width}
							aria-hidden="true"
							className="flex h-8 items-center gap-2 px-2"
						>
							<Skeleton className="library-shimmer size-3.5 shrink-0 rounded-sm" />
							<Skeleton className="library-shimmer h-3.5" style={{ width }} />
							<Skeleton className="library-shimmer ml-auto h-3 w-4 shrink-0" />
						</div>
					))}
				</div>
				<div className="flex min-h-0 flex-col gap-2">
					<div className="flex items-center gap-2" aria-hidden="true">
						<Skeleton className="library-shimmer h-8 min-w-0 flex-1" />
						<Skeleton className="library-shimmer h-8 w-14 shrink-0" />
						<Skeleton className="library-shimmer h-8 w-14 shrink-0" />
					</div>
					<div className="h-72 space-y-0.5 rounded-md border p-1.5">
						{PAPER_SKELETON_WIDTHS.map((width) => (
							<div
								key={width}
								aria-hidden="true"
								className="flex items-start gap-2 px-1.5 py-1"
							>
								<Skeleton className="library-shimmer mt-0.5 size-4 shrink-0 rounded-[4px]" />
								<div className="min-w-0 flex-1 space-y-1.5">
									<Skeleton
										className="library-shimmer h-3.5"
										style={{ width }}
									/>
									<Skeleton className="library-shimmer h-3 w-1/2" />
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

export function AlphaXivImportDialog({
	open,
	onOpenChange,
	vaultPath,
	onDone,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vaultPath: string | null;
	onDone: () => void;
}) {
	const { t, i18n: translation } = useTranslation("sidebar");
	const libraryPapers = useLibraryStore((s) => s.papers);
	const inVault = useMemo(
		() => libraryArxivIds(libraryPapers),
		[libraryPapers],
	);
	const [folders, setFolders] = useState<AlphaXivFolder[]>([]);
	const [loading, setLoading] = useState(false);
	const [needsKey, setNeedsKey] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [tagFolders, setTagFolders] = useState(true);
	const [reloadToken, setReloadToken] = useState(0);
	const importStarted = useRef(false);

	useOverlayRegistration("alphaxiv-import", open, () => {
		onOpenChange(false);
	});

	useEffect(() => {
		// Reading `reloadToken` is what re-runs this load after Try again.
		if (!open || reloadToken < 0) return;
		let cancelled = false;
		setFolders([]);
		setError(null);
		setNeedsKey(false);
		setQuery("");
		setTagFolders(true);
		setSelected(new Set());
		setActiveFolderId(null);
		if (!isTauri()) {
			setError(i18n.t("sidebar:alphaxivImport.desktopOnly"));
			setLoading(false);
			return;
		}
		if (!vaultPath) {
			setError(i18n.t("sidebar:alphaxivImport.noVault"));
			setLoading(false);
			return;
		}
		if (!hasSecret(loadSettings().alphaxiv?.apiKey)) {
			setNeedsKey(true);
			setLoading(false);
			return;
		}
		setLoading(true);
		void callApi(() => commands.alphaxivListFolders(), {
			fallback: i18n.t("sidebar:alphaxivImport.loadFailed"),
		})
			.then((loaded) => {
				if (cancelled) return;
				setFolders(loaded);
				setSelected(
					defaultSelected(
						loaded,
						libraryArxivIds(libraryStore.getState().papers),
					),
				);
				setActiveFolderId(folderNodes(loaded)[0]?.folder.id ?? null);
			})
			.catch((loadError: unknown) => {
				if (cancelled) return;
				if (isKeyMissing(loadError)) {
					setNeedsKey(true);
					return;
				}
				const message = errorText(loadError);
				setError(message);
				notifyError(message);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, reloadToken, vaultPath]);

	const nodes = useMemo(() => folderNodes(folders), [folders]);
	const active =
		nodes.find((node) => node.folder.id === activeFolderId)?.folder ??
		nodes[0]?.folder ??
		null;
	const visiblePapers = useMemo(() => {
		if (!active) return [];
		const needle = query.trim().toLowerCase();
		return active.papers
			.map((paper, index) => ({ paper, index }))
			.filter(({ paper }) => {
				if (!needle) return true;
				const haystack = [paper.title, paper.arxivId, ...paper.authors]
					.join("\n")
					.toLowerCase();
				return haystack.includes(needle);
			});
	}, [active, query]);
	const plan: AlphaXivImportPlanItem[] = useMemo(
		() =>
			planAlphaXivImport(
				selectedSources(folders, selected, translation.language),
			),
		[folders, selected, translation.language],
	);

	const handleOpenChange = (next: boolean) => {
		onOpenChange(next);
	};

	const togglePaper = (key: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const setFolderSelected = (folder: AlphaXivFolder, on: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			folder.papers.forEach((paper, index) => {
				if (!paper.importable || alreadyInLibrary(paper, inVault)) return;
				const key = rowKey(folder.id, paper, index);
				if (on) next.add(key);
				else next.delete(key);
			});
			return next;
		});
	};

	const runImport = () => {
		if (!vaultPath || plan.length === 0 || importStarted.current) return;
		importStarted.current = true;
		const items = plan;
		const withTags = tagFolders;
		// The lookup job shows in the bottom-left task panel, so the dialog
		// does not stay open for a summary.
		onOpenChange(false);
		void importAlphaXivPlan(items, { tagFolders: withTags })
			.then((result) => {
				onDone();
				if (result.revealDir) openPaper(result.revealDir);
			})
			.catch((importError: unknown) => {
				notifyError(errorText(importError));
			})
			.finally(() => {
				importStarted.current = false;
			});
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				className="flex max-h-[85vh] flex-col sm:max-w-3xl"
				aria-describedby={undefined}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<AlphaXivIcon className="size-4 shrink-0 text-[#B33131]" />
						{t("alphaxivImport.title")}
					</DialogTitle>
				</DialogHeader>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{needsKey ? (
						<p className="py-2 text-muted-foreground text-sm">
							{t("alphaxivImport.needsKey")}
						</p>
					) : loading ? (
						<AlphaXivImportSkeleton label={t("alphaxivImport.loading")} />
					) : error && folders.length === 0 ? (
						<div className="space-y-3 py-2">
							<p className="text-destructive text-sm">{error}</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setReloadToken((n) => n + 1)}
							>
								{t("alphaxivImport.retry")}
							</Button>
						</div>
					) : nodes.length === 0 ? (
						<p className="py-2 text-muted-foreground text-sm">
							{t("alphaxivImport.emptyFolders")}
						</p>
					) : (
						<div className="grid min-h-0 animate-in gap-3 fade-in-0 duration-200 sm:grid-cols-[12rem_minmax(0,1fr)]">
							<ScrollArea className="h-80 rounded-md border">
								<div className="space-y-0.5 p-1">
									{nodes.map((node) => (
										<button
											key={node.folder.id}
											type="button"
											className={
												node.folder.id === active?.id
													? "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm bg-accent"
													: "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/60"
											}
											style={{ paddingLeft: `${8 + node.depth * 12}px` }}
											onClick={() => setActiveFolderId(node.folder.id)}
										>
											<AlphaXivFolderIcon
												icon={node.folder.icon}
												color={node.folder.color}
												folderType={node.folder.folderType}
											/>
											<span className="min-w-0 flex-1 truncate">
												{folderTitle(node.folder, translation.language)}
											</span>
											<span className="shrink-0 text-muted-foreground text-xs">
												{node.folder.paperCount}
											</span>
										</button>
									))}
								</div>
							</ScrollArea>
							<div className="flex min-h-0 flex-col gap-2">
								<div className="flex items-center gap-2">
									<Input
										value={query}
										onChange={(event) => setQuery(event.target.value)}
										placeholder={t("alphaxivImport.searchPlaceholder")}
										className="h-8"
									/>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={!active}
										onClick={() => active && setFolderSelected(active, true)}
									>
										{t("alphaxivImport.selectAll")}
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={!active}
										onClick={() => active && setFolderSelected(active, false)}
									>
										{t("alphaxivImport.selectNone")}
									</Button>
								</div>
								<ScrollArea className="h-72 rounded-md border [&_[data-slot=scroll-area-viewport]>div]:block!">
									<div className="w-full min-w-0 space-y-0.5 p-1.5">
										{visiblePapers.length === 0 ? (
											<p className="px-1.5 py-2 text-muted-foreground text-xs">
												{t("alphaxivImport.emptyPapers")}
											</p>
										) : (
											visiblePapers.map(({ paper, index }) => {
												const key = active
													? rowKey(active.id, paper, index)
													: String(index);
												const inLibrary = inVault.has(
													arxivMatchKey(paper.arxivId),
												);
												return (
													<div
														key={key}
														className="flex w-full min-w-0 items-start gap-2 rounded px-1.5 py-1 hover:bg-accent/60"
													>
														{paper.importable && !inLibrary ? (
															<Checkbox
																className="mt-0.5"
																checked={selected.has(key)}
																onCheckedChange={() => togglePaper(key)}
															/>
														) : paper.importable ? (
															<span
																aria-disabled="true"
																className="mt-0.5 flex size-4 shrink-0 cursor-not-allowed items-center justify-center rounded-[4px] border border-input text-blue-700 opacity-50 dark:text-blue-400"
															>
																<Check className="size-3" />
															</span>
														) : (
															<span
																aria-disabled="true"
																className="mt-0.5 flex size-4 shrink-0 cursor-not-allowed items-center justify-center rounded-[4px] border border-input text-muted-foreground opacity-50"
															>
																<X className="size-3" />
															</span>
														)}
														<div className="min-w-0 flex-1">
															<div className="flex min-w-0 items-center gap-2">
																<p className="min-w-0 flex-1 truncate text-sm">
																	{paper.title || paper.arxivId || key}
																</p>
																{inLibrary ? (
																	<span className="shrink-0 whitespace-nowrap rounded bg-muted px-1 py-0.5 text-caption text-muted-foreground">
																		{t("alphaxivImport.alreadyInVault")}
																	</span>
																) : null}
															</div>
															<p className="truncate text-muted-foreground text-xs">
																{paper.importable
																	? paperLine(paper)
																	: t("alphaxivImport.privateReason")}
															</p>
														</div>
													</div>
												);
											})
										)}
									</div>
								</ScrollArea>
							</div>
						</div>
					)}
					{error && folders.length > 0 ? (
						<p className="mt-2 text-destructive text-xs">{error}</p>
					) : null}
				</div>

				<DialogFooter className="sm:justify-between">
					{needsKey || (!loading && folders.length === 0) ? (
						<span />
					) : (
						<label
							htmlFor="alphaxiv-tag-folders"
							className={
								loading
									? "pointer-events-none flex items-center gap-2 text-sm"
									: "flex items-center gap-2 text-sm"
							}
						>
							<Checkbox
								id="alphaxiv-tag-folders"
								checked={tagFolders}
								disabled={loading}
								onCheckedChange={(value) => setTagFolders(value === true)}
							/>
							{t("alphaxivImport.tagFolders")}
						</label>
					)}
					<div className="ml-auto flex items-center gap-2">
						{loading ? (
							<Skeleton
								aria-hidden="true"
								className="library-shimmer h-3 w-14"
							/>
						) : folders.length > 0 ? (
							<span className="text-muted-foreground text-xs">
								{t("alphaxivImport.selectedCount", { count: plan.length })}
							</span>
						) : null}
						{needsKey ? (
							<>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => openSettingsWindow("general")}
								>
									{t("alphaxivImport.openSettings")}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setReloadToken((n) => n + 1)}
								>
									{t("alphaxivImport.retry")}
								</Button>
							</>
						) : (
							<>
								<Button
									type="button"
									variant="ghost"
									onClick={() => handleOpenChange(false)}
								>
									{t("alphaxivImport.cancel")}
								</Button>
								<Button
									type="button"
									className="gap-1.5"
									disabled={plan.length === 0 || !vaultPath}
									onClick={runImport}
								>
									<Import className="size-3.5" />
									{t("alphaxivImport.import")}
								</Button>
							</>
						)}
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
