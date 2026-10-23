/**
 * Vault title bar: switch vault dropdown + magic-wand import popover.
 * Stateless relative to FileTree (no shared internal state).
 */

import {
	Check,
	ChevronsUpDown,
	FileUp,
	FolderInput,
	FolderOpen,
	FolderPlus,
	Loader2,
	RefreshCw,
	Server,
	Trash2,
	Upload,
	WandSparkles,
	X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SiZotero } from "react-icons/si";
import {
	type OpenRemoteVaultArgs,
	RemoteVaultDialog,
} from "@/components/dialogs/remote-vault-dialog";
import { PaneHeader } from "@/components/shell/pane-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { type ChatImportExtractResult, commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { displayPath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { inferLookupSource } from "@/lib/paper/import-actions";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import { vaultDisplayName } from "@/lib/vault";
import {
	getRecentRemoteVaults,
	getRemoteSessionMeta,
	isRemoteVaultHandle,
	type RecentRemoteVault,
	removeRecentRemoteVault,
} from "@/lib/vault/remote/remote-vault";

export type VaultSidebarHeaderProps = {
	title: string;
	/** Transient tree multi-selection mode; replaces, never stacks on, this header. */
	selection?: {
		count: number;
		disabled?: boolean;
		onClear: () => void;
		onMove?: (anchor: { x: number; y: number }) => void;
		onDelete: () => void;
	};
	/** Vault-relative papers parent, e.g. `papers` or `papers/nlp` */
	lookupParentDir: string;
	onLookupSubmit: (texts: string[]) => Promise<void>;
	/** Chat-review confirm (#652): one batch import job for the checked rows. */
	onLookupBatchSubmit?: (texts: string[]) => Promise<void>;
	/** Bibliography import (bottom-left of magic-wand popover). */
	onImportBibliography?: () => void | Promise<void>;
	/** Local PDF import (bottom-left of magic-wand popover). */
	onImportLocalPdf?: () => void | Promise<void>;
	importBusy?: boolean;
	importPdfBusy?: boolean;
	busy?: boolean;
	isDemo: boolean;
	/**
	 * Increment from App (e.g. ⇧⌘I) to open the magic-wand popover.
	 * Only reacts to positive values after mount.
	 */
	lookupOpenSignal?: number;
	recentVaults: string[];
	vaultPath: string | null;
	onOpenRecent: (path: string) => void;
	onRemoveRecent: (path: string) => void;
	onOpenVault: () => void;
	onCreateVault: () => void;
	/** Open remote vault via SSH (host + remote path). */
	onOpenRemoteVault?: (args: OpenRemoteVaultArgs) => void | Promise<void>;
	/** Migrate from Zotero (item in the vault switcher dropdown). */
	onMigrateZotero?: () => void;
	/** Bidirectional Zotero sync (item in the vault switcher dropdown). */
	onSyncZotero?: () => void;
};

export const VaultSidebarHeader = memo(function VaultSidebarHeader({
	title,
	selection,
	lookupParentDir,
	onLookupSubmit,
	onLookupBatchSubmit,
	onImportBibliography,
	onImportLocalPdf,
	importBusy,
	importPdfBusy,
	busy,
	isDemo,
	lookupOpenSignal = 0,
	recentVaults,
	vaultPath,
	onOpenRecent,
	onRemoveRecent,
	onOpenVault,
	onCreateVault,
	onOpenRemoteVault,
	onMigrateZotero,
	onSyncZotero,
}: VaultSidebarHeaderProps) {
	const { t } = useTranslation(["sidebar", "shortcuts", "app"]);
	const [wandOpen, setWandOpen] = useState(false);
	const [lookupText, setLookupText] = useState("");
	const [lookupBusy, setLookupBusy] = useState(false);
	const [lookupError, setLookupError] = useState<string | null>(null);
	// Chat-paste review state (#652): extracted ids + which rows are checked.
	const [chatExtract, setChatExtract] =
		useState<ChatImportExtractResult | null>(null);
	const [chatSelected, setChatSelected] = useState<Set<string>>(new Set());
	const lookupTextareaRef = useRef<HTMLTextAreaElement>(null);
	// IME: compositionend can fire before the confirming Enter (see useImeGuard).
	const { isBlockedByIme, compositionProps } = useImeGuard();
	const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);
	const [recentRemotes, setRecentRemotes] = useState<RecentRemoteVault[]>(() =>
		getRecentRemoteVaults(),
	);

	const refreshRecentRemotes = useCallback(() => {
		setRecentRemotes(getRecentRemoteVaults());
	}, []);

	const isActiveRemote = useCallback(
		(entry: RecentRemoteVault) => {
			if (!vaultPath || !isRemoteVaultHandle(vaultPath)) return false;
			const meta = getRemoteSessionMeta();
			if (!meta) return false;
			const pathMatch = meta.remotePath === entry.remotePath;
			const hostMatch =
				meta.host === entry.host ||
				meta.host === `${entry.user ? `${entry.user}@` : ""}${entry.host}` ||
				meta.host.endsWith(`@${entry.host}`) ||
				meta.displayName.includes(`${entry.host}:`);
			return pathMatch && hostMatch;
		},
		[vaultPath],
	);
	const actionsDisabled =
		busy || isDemo || Boolean(importBusy) || Boolean(importPdfBusy);
	const lookupDisabled = busy || isDemo;
	const magicWandShortcut = formatShortcutById("magicWand");
	const selectionActive = Boolean(selection && selection.count > 0);

	useEffect(() => {
		if (selectionActive) setWandOpen(false);
	}, [selectionActive]);

	useEffect(() => {
		if (lookupOpenSignal <= 0 || isDemo || busy) return;
		setWandOpen(true);
		setLookupError(null);
	}, [lookupOpenSignal, isDemo, busy]);

	/**
	 * Split on line/list separators only — spaces belong to titles and to
	 * `npx skills add …`. The Host expands space-separated identifier lists.
	 */
	const parseLookupTexts = (text: string): string[] =>
		text
			.split(/[\n\r,;，；]+/)
			.map((t) => t.trim())
			.filter(Boolean);

	const runLookup = async () => {
		if (lookupBusy) return;
		const raw = lookupText.trim();
		if (!raw) return;
		setLookupBusy(true);
		setLookupError(null);
		try {
			// Chat-paste flow (#652): scan the input first. ≥2 identifiers
			// switches to a review checklist instead of importing sight-unseen;
			// plain identifier lists and title searches fall through unchanged.
			// Local for pasted text; share URLs fetch once host-side.
			// A blob containing a Skill source keeps the legacy per-segment
			// path — Skill discovery must not be silently dropped by the
			// checklist (review point on #814).
			const segments = parseLookupTexts(raw);
			const hasSkillSegment = segments.some(
				(s) => inferLookupSource(s) === "skill",
			);
			if (isTauri() && !hasSkillSegment) {
				const extracted = await callApiResult(
					() => commands.chatImportExtract({ text: raw }),
					{ fallback: t("lookup.fetchFailed") },
				);
				const total =
					extracted.arxiv.length +
					extracted.dois.length +
					extracted.pmids.length;
				if (total >= 2) {
					setChatExtract(extracted);
					setChatSelected(
						new Set([
							...extracted.arxiv.map((id) => `arxiv:${id}`),
							...extracted.dois.map((d) => `doi:${d}`),
							...extracted.pmids.map((p) => `pmid:${p}`),
						]),
					);
					return;
				}
			}
			const texts = parseLookupTexts(lookupText);
			if (texts.length === 0) return;
			await onLookupSubmit(texts);
			setLookupText("");
			setWandOpen(false);
		} catch (e) {
			setLookupError(errorText(e));
		} finally {
			setLookupBusy(false);
		}
	};

	/** Flatten extracted ids into review rows; submit texts use forms the
	 * Host identifier pipeline resolves directly. */
	const chatItems = useMemo(() => {
		if (!chatExtract) return [];
		return [
			...chatExtract.arxiv.map((id) => ({
				key: `arxiv:${id}`,
				label: `arXiv:${id}`,
				submit: `arXiv:${id}`,
			})),
			...chatExtract.dois.map((d) => ({
				key: `doi:${d}`,
				label: d,
				submit: `https://doi.org/${d}`,
			})),
			...chatExtract.pmids.map((p) => ({
				key: `pmid:${p}`,
				label: `PMID: ${p}`,
				submit: `https://pubmed.ncbi.nlm.nih.gov/${p}/`,
			})),
		];
	}, [chatExtract]);

	const toggleChatItem = (key: string, on: boolean) => {
		setChatSelected((prev) => {
			const next = new Set(prev);
			if (on) next.add(key);
			else next.delete(key);
			return next;
		});
	};

	const confirmChatReview = async () => {
		if (lookupBusy || !chatExtract) return;
		const texts = chatItems
			.filter((item) => chatSelected.has(item.key))
			.map((item) => item.submit);
		if (texts.length === 0) return;
		// One batch job (batch-level dedup + n/total progress), not per-row
		// lookup jobs.
		const submit = onLookupBatchSubmit ?? onLookupSubmit;
		setLookupBusy(true);
		setLookupError(null);
		try {
			await submit(texts);
			setLookupText("");
			setChatExtract(null);
			setWandOpen(false);
		} catch (e) {
			setLookupError(errorText(e));
		} finally {
			setLookupBusy(false);
		}
	};

	if (selection && selection.count > 0) {
		return (
			<TooltipProvider delayDuration={300}>
				<div className="shrink-0">
					<PaneHeader
						className="relative z-10 border-b-0"
						trailing={
							<>
								{selection.onMove ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon-xs"
												disabled={selection.disabled}
												aria-label={t("sidebar:fileTree.moveSelected", {
													count: selection.count,
												})}
												onClick={(event) => {
													const rect =
														event.currentTarget.getBoundingClientRect();
													selection.onMove?.({ x: rect.left, y: rect.top });
												}}
											>
												<FolderInput className="size-3.5" />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="bottom">
											{t("sidebar:fileTree.moveSelected", {
												count: selection.count,
											})}
										</TooltipContent>
									</Tooltip>
								) : null}
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											className="text-destructive"
											disabled={selection.disabled}
											aria-label={t("sidebar:fileTree.deleteSelected", {
												count: selection.count,
											})}
											onClick={selection.onDelete}
										>
											<Trash2 className="size-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{t("sidebar:fileTree.deleteSelected", {
											count: selection.count,
										})}
									</TooltipContent>
								</Tooltip>
							</>
						}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label={t("sidebar:fileTree.clearSelection")}
									onClick={selection.onClear}
								>
									<X className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("sidebar:fileTree.clearSelection")}
							</TooltipContent>
						</Tooltip>
						<span className="min-w-0 truncate font-medium text-sm">
							{t("sidebar:fileTree.selectedCount", {
								count: selection.count,
							})}
						</span>
					</PaneHeader>
				</div>
			</TooltipProvider>
		);
	}

	return (
		<TooltipProvider delayDuration={300}>
			<div className="shrink-0">
				<PaneHeader
					className="relative z-10 border-b-0"
					trailing={
						<Popover
							open={wandOpen}
							onOpenChange={(open) => {
								setWandOpen(open);
								if (!open) setLookupError(null);
							}}
						>
							<Tooltip>
								<TooltipTrigger asChild>
									<PopoverTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											data-magic-wand
											aria-label={t("lookup.magicWand")}
											disabled={lookupDisabled}
										>
											<WandSparkles className="size-3.5" />
										</Button>
									</PopoverTrigger>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{t("lookup.magicWand")}
									<span className="ml-2 text-muted-foreground">
										{magicWandShortcut}
									</span>
								</TooltipContent>
							</Tooltip>
							<PopoverContent
								align="end"
								side="bottom"
								className="w-72 gap-2 p-2.5"
							>
								<form
									className="flex flex-col gap-2"
									onSubmit={(e) => {
										e.preventDefault();
										void (chatExtract ? confirmChatReview() : runLookup());
									}}
								>
									<p className="text-muted-foreground text-xs">
										{t("lookup.addTo", { path: lookupParentDir })}
									</p>
									{chatExtract ? (
										<div className="flex flex-col gap-1.5">
											<div className="flex items-center justify-between gap-2">
												<span className="text-xs">
													{t("lookup.chatFound", {
														count: chatItems.length,
													})}
												</span>
												{chatExtract.fetchedFrom ? (
													<span className="truncate text-caption text-muted-foreground">
														{t("lookup.chatShareFetched")}
													</span>
												) : null}
											</div>
											<div className="max-h-44 space-y-1 overflow-y-auto pr-1">
												{chatItems.map((item) => {
													const checkboxId = `chat-import-${item.key}`;
													return (
														<label
															key={item.key}
															htmlFor={checkboxId}
															className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-accent/40"
														>
															<Checkbox
																id={checkboxId}
																checked={chatSelected.has(item.key)}
																disabled={lookupBusy}
																onCheckedChange={(value) =>
																	toggleChatItem(item.key, value === true)
																}
															/>
															<span className="truncate font-mono text-xs">
																{item.label}
															</span>
														</label>
													);
												})}
											</div>
										</div>
									) : (
										<Textarea
											ref={lookupTextareaRef}
											value={lookupText}
											onChange={(e) => {
												setLookupText(e.target.value);
												// Auto-grow up to max-h-32; shrink when lines are removed.
												const el = lookupTextareaRef.current;
												if (el) {
													el.style.height = "auto";
													el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
												}
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter" && !e.shiftKey) {
													// Let the IME confirm its candidate; don't search yet.
													if (isBlockedByIme(e)) return;
													e.preventDefault();
													void runLookup();
												}
											}}
											{...compositionProps}
											placeholder={t("lookup.placeholder")}
											disabled={lookupBusy}
											className="min-h-[2.5rem] max-h-32 resize-none overflow-y-auto text-xs"
											rows={1}
										/>
									)}
									{lookupError ? (
										<p className="text-destructive text-xs leading-snug">
											{lookupError}
										</p>
									) : null}
									{/* Imports bottom-left (PDF · bibliography) · Add bottom-right */}
									{chatExtract ? (
										<>
											<button
												type="button"
												className="text-caption text-muted-foreground hover:text-foreground"
												disabled={lookupBusy}
												onClick={() => {
													const allSelected =
														chatSelected.size === chatItems.length &&
														chatItems.length > 0;
													setChatSelected(
														allSelected
															? new Set()
															: new Set(chatItems.map((item) => item.key)),
													);
												}}
											>
												{chatSelected.size === chatItems.length &&
												chatItems.length > 0
													? t("lookup.skillImportSelectNone")
													: t("lookup.skillImportSelectAll")}
											</button>
											<div className="flex items-center gap-1">
												<Button
													type="button"
													variant="outline"
													size="sm"
													className="h-7 px-2.5 text-xs"
													disabled={lookupBusy}
													onClick={() => {
														setChatExtract(null);
														setLookupError(null);
													}}
												>
													{t("lookup.chatBack")}
												</Button>
												<Button
													type="submit"
													size="sm"
													className="h-7 px-2.5 text-xs"
													disabled={lookupBusy || chatSelected.size === 0}
												>
													{lookupBusy
														? t("lookup.adding")
														: t("lookup.chatConfirm", {
																count: chatSelected.size,
															})}
												</Button>
											</div>
										</>
									) : (
										<div className="flex items-center justify-between gap-2">
											<div className="flex items-center gap-1">
												{onImportLocalPdf ? (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																type="button"
																variant="ghost"
																size="icon-xs"
																disabled={
																	actionsDisabled || Boolean(importBusy)
																}
																aria-label={t("papersLibrary.importPdf")}
																onClick={() => {
																	void onImportLocalPdf();
																}}
															>
																{importPdfBusy ? (
																	<Loader2 className="size-3.5 animate-spin" />
																) : (
																	<FileUp className="size-3.5" />
																)}
															</Button>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															{t("papersLibrary.importPdf")}
														</TooltipContent>
													</Tooltip>
												) : null}
												{onImportBibliography ? (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																type="button"
																variant="ghost"
																size="icon-xs"
																disabled={
																	actionsDisabled || Boolean(importBusy)
																}
																aria-label={t("papersLibrary.import")}
																onClick={() => {
																	void onImportBibliography();
																}}
															>
																{importBusy ? (
																	<Loader2 className="size-3.5 animate-spin" />
																) : (
																	<Upload className="size-3.5" />
																)}
															</Button>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															{t("papersLibrary.import")}
														</TooltipContent>
													</Tooltip>
												) : null}
											</div>
											<Button
												type="submit"
												size="sm"
												className="h-7 px-2.5 text-xs"
												disabled={lookupBusy || !lookupText.trim()}
											>
												{lookupBusy ? t("lookup.adding") : t("lookup.add")}
											</Button>
										</div>
									)}
								</form>
							</PopoverContent>
						</Popover>
					}
				>
					<DropdownMenu
						onOpenChange={(open) => {
							if (open) refreshRecentRemotes();
						}}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-muted"
										aria-label={t("app:vault.switchVault")}
									>
										<span
											className="truncate font-medium text-sm"
											title={title}
										>
											{title}
										</span>
										<ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
									</button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("app:vault.switchVault")}
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="start" className="w-72">
							<DropdownMenuLabel>
								{t("app:vault.recentTitle")}
							</DropdownMenuLabel>
							{recentRemotes.length === 0 && recentVaults.length === 0 ? (
								<div className="px-2 py-1.5 text-muted-foreground text-xs">
									{t("app:vault.recentEmpty")}
								</div>
							) : null}
							{recentRemotes.map((entry) => {
								const key = `${entry.host}\0${entry.user ?? ""}\0${entry.remotePath}`;
								const name = entry.label || entry.remotePath;
								const active = isActiveRemote(entry);
								return (
									<DropdownMenuItem
										key={key}
										onSelect={() => {
											if (!onOpenRemoteVault) return;
											void (async () => {
												await onOpenRemoteVault({
													host:
														entry.user && !entry.host.includes("@")
															? `${entry.user}@${entry.host}`
															: entry.host,
													remotePath: entry.remotePath,
												});
												refreshRecentRemotes();
											})();
										}}
										className="group flex items-center gap-2"
									>
										{active ? (
											<Check className="size-3.5 shrink-0" />
										) : (
											<Server className="size-3.5 shrink-0 text-muted-foreground" />
										)}
										<span className="min-w-0 flex-1">
											<span className="flex items-center gap-1.5 truncate text-sm">
												<span className="truncate">{name}</span>
												<span className="shrink-0 rounded bg-muted px-1 py-0.5 text-caption text-muted-foreground">
													{t("app:vault.remoteBadge")}
												</span>
											</span>
											<span className="block truncate text-muted-foreground text-xs">
												{entry.host}:{entry.remotePath}
											</span>
										</span>
										<button
											type="button"
											className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:block"
											aria-label={t("app:vault.removeRecent", { name })}
											onClick={(e) => {
												e.stopPropagation();
												removeRecentRemoteVault(entry);
												refreshRecentRemotes();
											}}
										>
											<X className="size-3" />
										</button>
									</DropdownMenuItem>
								);
							})}
							{recentVaults.map((p) => (
								<DropdownMenuItem
									key={p}
									onSelect={() => onOpenRecent(p)}
									className="group flex items-center gap-2"
								>
									{p === vaultPath ? (
										<Check className="size-3.5 shrink-0" />
									) : (
										<span className="size-3.5 shrink-0" />
									)}
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm">
											{vaultDisplayName(p)}
										</span>
										<span className="block truncate text-muted-foreground text-xs">
											{displayPath(p)}
										</span>
									</span>
									<button
										type="button"
										className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:block"
										aria-label={t("app:vault.removeRecent", {
											name: vaultDisplayName(p),
										})}
										onClick={(e) => {
											e.stopPropagation();
											onRemoveRecent(p);
										}}
									>
										<X className="size-3" />
									</button>
								</DropdownMenuItem>
							))}
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={onOpenVault}>
								<FolderOpen className="size-3.5" />
								{t("app:vault.openVaultButton")}
							</DropdownMenuItem>
							{onOpenRemoteVault ? (
								<DropdownMenuItem
									onSelect={() => {
										// Defer so the dropdown can close before the dialog opens.
										requestAnimationFrame(() => setRemoteDialogOpen(true));
									}}
								>
									<Server className="size-3.5" />
									{t("app:vault.openRemoteVaultButton")}
								</DropdownMenuItem>
							) : null}
							<DropdownMenuItem onSelect={onCreateVault}>
								<FolderPlus className="size-3.5" />
								{t("app:vault.createVaultButton")}
							</DropdownMenuItem>
							{onMigrateZotero || onSyncZotero ? (
								<DropdownMenuSeparator />
							) : null}
							{onMigrateZotero ? (
								<DropdownMenuItem
									disabled={actionsDisabled}
									onSelect={() => {
										requestAnimationFrame(() => onMigrateZotero());
									}}
								>
									<SiZotero className="size-3.5 text-[#CC2936]" />
									{t("zoteroMigrate.button")}
								</DropdownMenuItem>
							) : null}
							{onSyncZotero ? (
								<DropdownMenuItem
									disabled={actionsDisabled}
									onSelect={() => {
										requestAnimationFrame(() => onSyncZotero());
									}}
								>
									<RefreshCw className="size-3.5" />
									{t("zoteroSync.button")}
								</DropdownMenuItem>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
					{onOpenRemoteVault ? (
						<RemoteVaultDialog
							open={remoteDialogOpen}
							onOpenChange={setRemoteDialogOpen}
							busy={busy}
							onConnect={async (args) => {
								await onOpenRemoteVault(args);
								refreshRecentRemotes();
							}}
						/>
					) : null}
				</PaneHeader>
			</div>
		</TooltipProvider>
	);
});
