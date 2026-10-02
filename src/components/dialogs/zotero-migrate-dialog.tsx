import { openUrl } from "@tauri-apps/plugin-opener";
import {
	BookOpen,
	CheckCircle2,
	FolderOpen,
	Import,
	Loader2,
	Search,
	TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	chooseZoteroFolder,
	loadStoredOpts,
	useZoteroDirDetect,
} from "@/components/dialogs/zotero-dialog-shared";
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
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { writeJsonStorage } from "@/lib/core/storage";
import { runLocalActivity } from "@/lib/core/tasks";
import {
	discoverZoteroDirs,
	isSqliteMissingError,
	migrateZotero,
	scanZotero,
	suggestZoteroParentDir,
	type ZoteroMigrateResult,
	type ZoteroScan,
} from "@/lib/paper/import/zotero-migrate";
import { ensureVault } from "@/lib/vault";

/** Remembered import options (localStorage). */
const OPTS_KEY = "motif.zotero.opts";
type SavedOpts = {
	copyPdfs: boolean;
	preserveCollections: boolean;
	migrateNotes: boolean;
	migrateAnnotations: boolean;
	parentDir: string;
};
const DEFAULT_OPTS: SavedOpts = {
	copyPdfs: true,
	// Preserve the Zotero collection tree by default; users can still opt out
	// and the remembered preference takes precedence on subsequent migrations.
	preserveCollections: true,
	migrateNotes: true,
	migrateAnnotations: true,
	parentDir: "papers",
};

/** Item types that read as ordinary papers; anything else gets a type badge
 * in the picker so non-reference entries (webpage, …) stand out. */
const STANDARD_ITEM_TYPES = new Set([
	"journalArticle",
	"preprint",
	"conferencePaper",
	"thesis",
	"book",
	"bookSection",
	"report",
	"document",
]);
function saveOpts(o: SavedOpts) {
	writeJsonStorage(OPTS_KEY, o);
}

/** "View import tutorial" target: the "Migrate from Zotero" section of the docs site. */
const IMPORT_TUTORIAL_URL =
	"https://agentero-docs.poco-ai.com/usage/import-papers/#zotero";
function openTutorial() {
	void openUrl(IMPORT_TUTORIAL_URL).catch(() => {
		window.open(IMPORT_TUTORIAL_URL, "_blank");
	});
}

/**
 * One-click Zotero migration: auto-detect the library, pick the
 * exact papers (search + folder filter + per-item), choose options, then migrate
 * with a live progress bar and a result summary. Options are remembered.
 */
export function ZoteroMigrateDialog({
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
	const { t } = useTranslation(["sidebar", "app"]);
	const saved = useMemo(() => loadStoredOpts(OPTS_KEY, DEFAULT_OPTS), []);
	const [dir, setDir] = useState<string | null>(null);
	const [scan, setScan] = useState<ZoteroScan | null>(null);
	const [scanning, setScanning] = useState(false);
	const [suggestedDir, setSuggestedDir] = useState<string | null>(null);
	const [copyPdfs, setCopyPdfs] = useState(saved.copyPdfs);
	const [preserveCollections, setPreserveCollections] = useState(
		saved.preserveCollections,
	);
	const [migrateNotes, setMigrateNotes] = useState(saved.migrateNotes);
	const [migrateAnnotations, setMigrateAnnotations] = useState(
		saved.migrateAnnotations,
	);
	const [parentDir, setParentDir] = useState(saved.parentDir);
	const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
	const [query, setQuery] = useState("");
	const [collFilter, setCollFilter] = useState<number | "all">("all");
	const [progress, setProgress] = useState<{
		current: number;
		total: number;
	} | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<ZoteroMigrateResult | null>(null);

	useOverlayRegistration("zotero-migrate", open, () => onOpenChange(false));

	const reset = () => {
		setDir(null);
		setScan(null);
		setSelectedItems(new Set());
		setQuery("");
		setCollFilter("all");
		setProgress(null);
		setScanning(false);
		setSuggestedDir(null);
		setError(null);
		setBusy(false);
		setResult(null);
	};

	const handleOpenChange = (next: boolean) => {
		if (!next && !busy) {
			reset();
			// Closing after Vault creation must clear the initial tree loading state.
			onDone();
		}
		onOpenChange(next);
	};

	const applyScan = (picked: string, r: ZoteroScan) => {
		setDir(picked);
		setScan(r);
		setSelectedItems(new Set(r.items.map((i) => i.id)));
	};

	const scanDir = async (picked: string) => {
		setDir(picked);
		setScan(null);
		setSuggestedDir(null);
		setScanning(true);
		try {
			applyScan(picked, await scanZotero(picked));
		} catch (e) {
			if (isSqliteMissingError(e)) {
				// Common wrong pick (e.g. storage/): the parent is the data dir.
				const parent = await suggestZoteroParentDir(picked);
				if (parent) setSuggestedDir(parent);
				else setError(t("sidebar:zoteroMigrate.sqliteMissing"));
			} else {
				setError(errorText(e));
			}
		} finally {
			setScanning(false);
		}
	};

	const chooseFolder = () =>
		chooseZoteroFolder(setError, (picked) => scanDir(picked));

	// On open, try the default ~/Zotero folder so most users skip browsing.
	const detecting = useZoteroDirDetect(open, dir, {
		detect: async (isCancelled) => {
			for (const candidate of await discoverZoteroDirs()) {
				const r = await scanZotero(candidate);
				if (!isCancelled() && r.valid && r.itemCount > 0) {
					applyScan(candidate, r);
					break;
				}
			}
		},
	});

	// Collection helpers: depth + descendant-inclusive item counts, so picking
	// a parent folder clearly means "this folder and everything inside it".
	const collectionInfo = useMemo(() => {
		if (!scan) return null;
		const idToPath = new Map<number, string>();
		for (const c of scan.collections) idToPath.set(c.id, c.path);
		const inclusive = new Map<number, number>();
		for (const c of scan.collections) {
			let n = 0;
			if (c.id === 0) {
				n = scan.items.filter((it) => it.collections.length === 0).length;
			} else {
				const prefix = `${c.path}/`;
				for (const it of scan.items) {
					if (
						it.collections.some((cid) => {
							const p = idToPath.get(cid);
							return p !== undefined && (p === c.path || p.startsWith(prefix));
						})
					) {
						n++;
					}
				}
			}
			inclusive.set(c.id, n);
		}
		return { idToPath, inclusive };
	}, [scan]);

	const filtered = useMemo(() => {
		if (!scan) return [];
		const q = query.trim().toLowerCase();
		const selectedPath =
			collectionInfo && typeof collFilter === "number" && collFilter !== 0
				? collectionInfo.idToPath.get(collFilter)
				: undefined;
		const prefix = selectedPath !== undefined ? `${selectedPath}/` : undefined;
		return scan.items.filter((it) => {
			if (q && !it.title.toLowerCase().includes(q)) return false;
			if (collFilter === "all") return true;
			if (collFilter === 0) return it.collections.length === 0;
			// A folder selection includes every descendant folder's papers.
			if (selectedPath !== undefined && prefix !== undefined) {
				return it.collections.some((cid) => {
					const p = collectionInfo?.idToPath.get(cid);
					return (
						p !== undefined && (p === selectedPath || p.startsWith(prefix))
					);
				});
			}
			return it.collections.includes(collFilter);
		});
	}, [scan, query, collFilter, collectionInfo]);

	const allFilteredSelected =
		filtered.length > 0 && filtered.every((it) => selectedItems.has(it.id));
	const toggleItem = (id: number) =>
		setSelectedItems((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const toggleFiltered = () =>
		setSelectedItems((prev) => {
			const next = new Set(prev);
			if (allFilteredSelected) for (const it of filtered) next.delete(it.id);
			else for (const it of filtered) next.add(it.id);
			return next;
		});

	const handleMigrate = async () => {
		if (!vaultPath || !dir || !scan) return;
		saveOpts({
			copyPdfs,
			preserveCollections,
			migrateNotes,
			migrateAnnotations,
			parentDir,
		});
		setBusy(true);
		setError(null);
		setProgress({ current: 0, total: selectedItems.size });
		try {
			const res = await runLocalActivity(
				{
					kind: "zoteroMigrate",
					title: t("sidebar:zoteroMigrate.task"),
					detail: dir,
				},
				async ({ setDetail, setProgress: setBg }) => {
					// Ensure onboarding tutorial notes exist before migration
					// (new vaults already have them; existing vaults may be missing them).
					try {
						await ensureVault(vaultPath, i18n.language);
					} catch {
						// Best-effort: do not block Zotero migration if ensure fails.
					}
					return migrateZotero({
						vaultPath,
						zoteroDir: dir,
						parentDir: parentDir.trim() || "papers",
						copyPdfs,
						preserveCollections,
						migrateNotes,
						migrateAnnotations,
						includeItems:
							selectedItems.size === scan.items.length
								? undefined
								: Array.from(selectedItems),
						// Multi-folder items land inside the folder being imported,
						// not in some deeper unrelated branch.
						preferCollection:
							typeof collFilter === "number" && collFilter !== 0
								? collFilter
								: undefined,
						onProgress: (current, total) => {
							setProgress({ current, total });
							setBg(total ? Math.round((current / total) * 100) : null);
							setDetail(
								t("sidebar:zoteroMigrate.progressLabel", {
									current,
									total,
								}),
							);
						},
					});
				},
			);
			onDone();
			setResult(res);
			setBusy(false);
		} catch (e) {
			setError(errorText(e));
			setBusy(false);
		}
	};

	const migrateDisabled =
		busy || !scan || !vaultPath || selectedItems.size === 0;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				className="flex max-h-[85vh] flex-col sm:max-w-2xl"
				aria-describedby={undefined}
			>
				<DialogHeader>
					<DialogTitle>{t("sidebar:zoteroMigrate.title")}</DialogTitle>
				</DialogHeader>

				<div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
					{result ? (
						<div className="space-y-3 py-1">
							<div className="flex items-center gap-2 font-medium text-sm">
								<CheckCircle2 className="size-5 text-emerald-500" />
								{t("sidebar:zoteroMigrate.summaryTitle")}
							</div>
							<ul className="space-y-1 text-muted-foreground text-sm">
								<li>
									{t("sidebar:zoteroMigrate.summaryImported", {
										count: result.imported,
									})}
								</li>
								{result.notesAdded > 0 ? (
									<li>
										{t("sidebar:zoteroMigrate.summaryNotes", {
											count: result.notesAdded,
										})}
									</li>
								) : null}
								{result.relocated > 0 ? (
									<li>
										{t("sidebar:zoteroMigrate.summaryRelocated", {
											count: result.relocated,
										})}
									</li>
								) : null}
								{result.copiedPdfs > 0 ? (
									<li>
										{t("sidebar:zoteroMigrate.summaryPdfs", {
											count: result.copiedPdfs,
										})}
									</li>
								) : null}
								{result.pruned > 0 ? (
									<li>
										{t("sidebar:zoteroMigrate.summaryPruned", {
											count: result.pruned,
										})}
									</li>
								) : null}
								{result.skipped > 0 ? (
									<li>
										{t("sidebar:zoteroMigrate.summarySkipped", {
											count: result.skipped,
										})}
									</li>
								) : null}
								{result.ignoredUnsupported > 0 ? (
									<li>
										{t("sidebar:zoteroMigrate.summaryIgnoredUnsupported", {
											count: result.ignoredUnsupported,
										})}
									</li>
								) : null}
								{result.mergedDuplicates > 0 ? (
									<li>
										{t("sidebar:zoteroMigrate.summaryDuplicates", {
											count: result.mergedDuplicates,
										})}
									</li>
								) : null}
								{result.errors.length > 0 ? (
									<li className="text-destructive">
										{t("sidebar:zoteroMigrate.summaryErrors", {
											count: result.errors.length,
										})}
									</li>
								) : null}
							</ul>
						</div>
					) : (
						<div className="space-y-4">
							<p className="text-muted-foreground text-xs">
								{t("sidebar:zoteroMigrate.stepsHint")}
							</p>
							<div className="space-y-1.5">
								<Button
									type="button"
									variant="outline"
									className="w-full justify-start gap-2"
									onClick={() => void chooseFolder()}
									disabled={busy || detecting}
								>
									<FolderOpen className="size-4 shrink-0" />
									<span className="truncate">
										{dir ?? t("sidebar:zoteroMigrate.chooseFolder")}
									</span>
								</Button>
							</div>

							{scanning || detecting ? (
								<p className="flex items-center gap-2 text-muted-foreground text-sm">
									<Loader2 className="size-3.5 animate-spin" />
									{detecting
										? t("sidebar:zoteroMigrate.detecting")
										: t("sidebar:zoteroMigrate.scanning")}
								</p>
							) : null}

							{suggestedDir && !scanning ? (
								<div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
									<TriangleAlert className="size-4 shrink-0 text-amber-500" />
									<span
										className="min-w-0 flex-1 truncate text-muted-foreground"
										title={suggestedDir}
									>
										{t("sidebar:zoteroMigrate.parentFound")}
									</span>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="h-7 shrink-0 px-2 text-xs"
										disabled={busy}
										onClick={() => void scanDir(suggestedDir)}
									>
										{t("sidebar:zoteroMigrate.useParent")}
									</Button>
								</div>
							) : null}

							{scan ? (
								<>
									<div className="grid grid-cols-2 gap-3">
										<div className="space-y-1.5">
											<Label htmlFor="zotero-parent" className="text-xs">
												{t("sidebar:zoteroMigrate.targetFolder")}
											</Label>
											<Input
												id="zotero-parent"
												value={parentDir}
												onChange={(e) => setParentDir(e.target.value)}
												disabled={busy}
											/>
										</div>
									</div>

									<div className="grid grid-cols-2 gap-x-3 gap-y-2">
										<Toggle
											id="zotero-copy-pdfs"
											checked={copyPdfs}
											onChange={setCopyPdfs}
											disabled={busy}
											label={t("sidebar:zoteroMigrate.copyPdfs")}
										/>
										<Toggle
											id="zotero-collections"
											checked={preserveCollections}
											onChange={setPreserveCollections}
											disabled={busy}
											label={t("sidebar:zoteroMigrate.preserveCollections")}
										/>
										<Toggle
											id="zotero-notes"
											checked={migrateNotes}
											onChange={setMigrateNotes}
											disabled={busy}
											label={t("sidebar:zoteroMigrate.migrateNotes")}
										/>
										<Toggle
											id="zotero-annotations"
											checked={migrateAnnotations}
											onChange={setMigrateAnnotations}
											disabled={busy}
											label={t("sidebar:zoteroMigrate.migrateAnnotations")}
										/>
									</div>

									<div className="space-y-1.5">
										<div className="flex items-center justify-between">
											<Label className="text-xs">
												{t("sidebar:zoteroMigrate.papers")}
											</Label>
											<div className="flex items-center gap-2">
												<span className="text-muted-foreground text-xs tabular-nums">
													{t("sidebar:zoteroMigrate.selectedCount", {
														sel: selectedItems.size,
														total: scan.items.length,
													})}
												</span>
												<button
													type="button"
													className="text-muted-foreground text-xs hover:text-foreground"
													onClick={toggleFiltered}
													disabled={busy || filtered.length === 0}
												>
													{allFilteredSelected
														? t("sidebar:zoteroMigrate.selectNone")
														: t("sidebar:zoteroMigrate.selectAll")}
												</button>
											</div>
										</div>
										<div className="flex gap-2">
											<div className="relative flex-1">
												<Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
												<Input
													value={query}
													onChange={(e) => setQuery(e.target.value)}
													placeholder={t(
														"sidebar:zoteroMigrate.searchPlaceholder",
													)}
													className="pl-8"
													disabled={busy}
												/>
											</div>
											{scan.collections.length > 0 ? (
												<Select
													value={String(collFilter)}
													onValueChange={(v) =>
														setCollFilter(v === "all" ? "all" : Number(v))
													}
													disabled={busy}
												>
													<SelectTrigger className="w-56 shrink-0">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="all">
															{t("sidebar:zoteroMigrate.allFolders")}
														</SelectItem>
														{scan.collections.map((c) => {
															const depth = c.path
																? c.path.split("/").length - 1
																: 0;
															const leaf = c.path
																? (c.path.split("/").pop() ?? c.path)
																: t("sidebar:zoteroMigrate.unfiled");
															const count =
																collectionInfo?.inclusive.get(c.id) ??
																c.itemCount;
															return (
																<SelectItem key={c.id} value={String(c.id)}>
																	<span
																		className="inline-block"
																		style={{ paddingLeft: `${depth * 12}px` }}
																	>
																		{depth > 0 ? "└ " : ""}
																		{leaf} ({count})
																	</span>
																</SelectItem>
															);
														})}
													</SelectContent>
												</Select>
											) : null}
										</div>
										{collFilter !== "all" ? (
											<p className="text-muted-foreground text-xs">
												{t("sidebar:zoteroMigrate.folderFilterHint")}
											</p>
										) : null}
										<ScrollArea className="h-56 rounded-md border">
											<div className="space-y-0.5 p-1.5">
												{filtered.map((it) => (
													<div
														key={it.id}
														className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-accent"
													>
														<Checkbox
															id={`zitem-${it.id}`}
															checked={selectedItems.has(it.id)}
															onCheckedChange={() => toggleItem(it.id)}
															disabled={busy}
														/>
														<label
															htmlFor={`zitem-${it.id}`}
															className="flex-1 cursor-pointer truncate text-sm"
														>
															{it.title}
															{it.year ? ` (${it.year})` : ""}
														</label>
														{it.itemType &&
														!STANDARD_ITEM_TYPES.has(it.itemType) ? (
															<span className="shrink-0 rounded bg-muted px-1 text-caption text-muted-foreground">
																{it.itemType}
															</span>
														) : null}
														{it.hasPdf ? (
															<span className="shrink-0 rounded bg-muted px-1 text-caption text-muted-foreground uppercase">
																pdf
															</span>
														) : null}
													</div>
												))}
											</div>
										</ScrollArea>
									</div>

									{busy && progress ? (
										<div className="space-y-1.5">
											<Progress
												value={
													progress.total
														? Math.round(
																(progress.current / progress.total) * 100,
															)
														: 0
												}
											/>
											<p className="text-center text-muted-foreground text-xs tabular-nums">
												{t("sidebar:zoteroMigrate.progressLabel", {
													current: progress.current,
													total: progress.total,
												})}
											</p>
										</div>
									) : null}
								</>
							) : null}

							{error ? (
								<p className="text-destructive text-xs">{error}</p>
							) : null}
						</div>
					)}
				</div>

				<DialogFooter className="sm:justify-between">
					<Button
						type="button"
						variant="link"
						className="h-auto gap-1.5 px-0 text-muted-foreground text-xs"
						onClick={openTutorial}
					>
						<BookOpen className="size-3.5" />
						{t("sidebar:zoteroMigrate.tutorial")}
					</Button>
					<div className="flex gap-2">
						{result ? (
							<Button type="button" onClick={() => handleOpenChange(false)}>
								{t("sidebar:zoteroMigrate.done")}
							</Button>
						) : (
							<>
								<Button
									type="button"
									variant="ghost"
									onClick={() => handleOpenChange(false)}
								>
									{t("sidebar:zoteroMigrate.cancel")}
								</Button>
								<Button
									type="button"
									className="gap-1.5"
									onClick={() => void handleMigrate()}
									disabled={migrateDisabled}
								>
									{busy ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										<Import className="size-3.5" />
									)}
									{t("sidebar:zoteroMigrate.migrate")}
								</Button>
							</>
						)}
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** A checkbox + label option row. */
function Toggle({
	id,
	checked,
	onChange,
	disabled,
	label,
}: {
	id: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
	label: string;
}) {
	return (
		<div className="flex items-center gap-2">
			<Checkbox
				id={id}
				checked={checked}
				onCheckedChange={(v) => onChange(v === true)}
				disabled={disabled}
			/>
			<label htmlFor={id} className="cursor-pointer text-sm">
				{label}
			</label>
		</div>
	);
}
