import { homeDir, join } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	BookOpen,
	CheckCircle2,
	FolderOpen,
	Import,
	Loader2,
	Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { isTauri } from "@/lib/tauri";
import {
	migrateZotero,
	pickZoteroDir,
	scanZotero,
	type ZoteroMigrateResult,
	type ZoteroScan,
} from "@/lib/zotero-migrate";
import { runBackgroundTask } from "@/stores/background-tasks-store";

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
	// Off by default: recreating every Zotero collection as a subfolder clutters
	// papers/ with grouping folders (e.g. “logs”/“Archive”). Opt in when wanted.
	preserveCollections: false,
	migrateNotes: true,
	migrateAnnotations: true,
	parentDir: "papers",
};
function loadOpts(): SavedOpts {
	try {
		return {
			...DEFAULT_OPTS,
			...JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}"),
		};
	} catch {
		return DEFAULT_OPTS;
	}
}
function saveOpts(o: SavedOpts) {
	try {
		localStorage.setItem(OPTS_KEY, JSON.stringify(o));
	} catch {
		// ignore quota / non-browser environments
	}
}

/** "View import tutorial" target. Replace with your hosted tutorial/docs URL. */
const IMPORT_TUTORIAL_URL =
	"https://github.com/poco-ai/motif/blob/main/docs/backend/identifier-lookup.md";
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
	const saved = useMemo(loadOpts, []);
	const [dir, setDir] = useState<string | null>(null);
	const [scan, setScan] = useState<ZoteroScan | null>(null);
	const [scanning, setScanning] = useState(false);
	const [detecting, setDetecting] = useState(false);
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
		setError(null);
		setBusy(false);
		setResult(null);
	};

	const handleOpenChange = (next: boolean) => {
		if (!next && !busy) reset();
		onOpenChange(next);
	};

	const applyScan = (picked: string, r: ZoteroScan) => {
		setDir(picked);
		setScan(r);
		setSelectedItems(new Set(r.items.map((i) => i.id)));
	};

	const chooseFolder = async () => {
		setError(null);
		const picked = await pickZoteroDir();
		if (!picked) return;
		setDir(picked);
		setScan(null);
		setScanning(true);
		try {
			applyScan(picked, await scanZotero(picked));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setScanning(false);
		}
	};

	// On open, try the default ~/Zotero folder so most users skip browsing.
	useEffect(() => {
		if (!open || dir || !isTauri()) return;
		let cancelled = false;
		void (async () => {
			setDetecting(true);
			try {
				const candidate = await join(await homeDir(), "Zotero");
				const r = await scanZotero(candidate);
				if (!cancelled && r.valid && r.itemCount > 0) {
					setDir(candidate);
					setScan(r);
					setSelectedItems(new Set(r.items.map((i) => i.id)));
				}
			} catch {
				// no default library here — the user picks the folder manually
			} finally {
				if (!cancelled) setDetecting(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, dir]);

	const filtered = useMemo(() => {
		if (!scan) return [];
		const q = query.trim().toLowerCase();
		return scan.items.filter((it) => {
			if (q && !it.title.toLowerCase().includes(q)) return false;
			if (collFilter === "all") return true;
			if (collFilter === 0) return it.collections.length === 0;
			return it.collections.includes(collFilter);
		});
	}, [scan, query, collFilter]);

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
		setProgress({ current: 0, total: scan.items.length });
		try {
			const res = await runBackgroundTask(
				{
					kind: "import",
					title: t("sidebar:zoteroMigrate.task"),
					detail: dir,
				},
				async ({ setDetail, setProgress: setBg }) => {
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
						onProgress: (current, total) => {
							setProgress({ current, total });
							setBg(total ? Math.round((current / total) * 100) : null);
							setDetail(
								t("sidebar:zoteroMigrate.progressLabel", { current, total }),
							);
						},
					});
				},
			);
			onDone();
			setResult(res);
			setBusy(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
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
													<SelectTrigger className="w-48 shrink-0">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="all">
															{t("sidebar:zoteroMigrate.allFolders")}
														</SelectItem>
														{scan.collections.map((c) => (
															<SelectItem key={c.id} value={String(c.id)}>
																{(c.path ||
																	t("sidebar:zoteroMigrate.unfiled")) +
																	` (${c.itemCount})`}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											) : null}
										</div>
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
														{it.hasPdf ? (
															<span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground uppercase">
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
