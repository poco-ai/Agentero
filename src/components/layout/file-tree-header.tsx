import {
	Check,
	ChevronsUpDown,
	FilePlus2,
	FileUp,
	FolderOpen,
	FolderPlus,
	Loader2,
	Server,
	Upload,
	WandSparkles,
	X,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { PaneHeader } from "@/components/layout/pane-header";
import {
	type OpenRemoteVaultArgs,
	RemoteVaultDialog,
} from "@/components/layout/remote-vault-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	getRecentRemoteVaults,
	getRemoteSessionMeta,
	isRemoteVaultHandle,
	type RecentRemoteVault,
	removeRecentRemoteVault,
} from "@/lib/remote-vault";
import { formatShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { vaultDisplayName } from "@/lib/vault";

/** Tooltip-wrapped ghost icon button used across the sidebar header. */
function IconAction({
	label,
	onClick,
	disabled,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={label}
					disabled={disabled}
					onClick={onClick}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

export function VaultSidebarHeader({
	title,
	onNewFile,
	onNewFolder,
	/** Vault-relative papers parent, e.g. `papers` or `papers/nlp` */
	lookupParentDir,
	onLookupSubmit,
	/** Bibliography import (bottom-left of magic-wand popover). */
	onImportBibliography,
	/** Local PDF import (bottom-left of magic-wand popover). */
	onImportLocalPdf,
	importBusy,
	importPdfBusy,
	busy,
	isDemo,
	/**
	 * Increment from App (e.g. ⇧⌘I) to open the magic-wand popover.
	 * Only reacts to positive values after mount.
	 */
	lookupOpenSignal = 0,
	recentVaults,
	vaultPath,
	onOpenRecent,
	onRemoveRecent,
	onOpenVault,
	onCreateVault,
	onOpenRemoteVault,
}: {
	title: string;
	onNewFile: () => void;
	onNewFolder: () => void;
	lookupParentDir: string;
	onLookupSubmit: (text: string) => Promise<void>;
	onImportBibliography?: () => void | Promise<void>;
	onImportLocalPdf?: () => void | Promise<void>;
	importBusy?: boolean;
	importPdfBusy?: boolean;
	busy?: boolean;
	isDemo: boolean;
	lookupOpenSignal?: number;
	recentVaults: string[];
	vaultPath: string | null;
	onOpenRecent: (path: string) => void;
	onRemoveRecent: (path: string) => void;
	onOpenVault: () => void;
	onCreateVault: () => void;
	/** Open remote vault via SSH (host + remote path). */
	onOpenRemoteVault?: (args: OpenRemoteVaultArgs) => void | Promise<void>;
}) {
	const { t } = useTranslation(["sidebar", "shortcuts", "app"]);
	const [wandOpen, setWandOpen] = useState(false);
	const [lookupText, setLookupText] = useState("");
	const [lookupBusy, setLookupBusy] = useState(false);
	const [lookupError, setLookupError] = useState<string | null>(null);
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
		busy ||
		isDemo ||
		lookupBusy ||
		Boolean(importBusy) ||
		Boolean(importPdfBusy);
	const magicWandShortcut = useMemo(() => {
		const def = SHORTCUTS.find((s) => s.id === "magicWand");
		return def ? formatShortcut(def) : "⇧⌘I";
	}, []);

	useEffect(() => {
		if (lookupOpenSignal <= 0 || isDemo || busy) return;
		setWandOpen(true);
		setLookupError(null);
	}, [lookupOpenSignal, isDemo, busy]);

	const runLookup = async () => {
		const text = lookupText.trim();
		if (!text || lookupBusy) return;
		setLookupBusy(true);
		setLookupError(null);
		try {
			await onLookupSubmit(text);
			setLookupText("");
			setWandOpen(false);
		} catch (e) {
			setLookupError(e instanceof Error ? e.message : String(e));
		} finally {
			setLookupBusy(false);
		}
	};

	return (
		<TooltipProvider delayDuration={300}>
			<div className="shrink-0">
				<PaneHeader
					className="bg-muted/20"
					trailing={
						<>
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
												aria-label={t("lookup.magicWand")}
												disabled={actionsDisabled}
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
											void runLookup();
										}}
									>
										<p className="text-muted-foreground text-xs">
											{t("lookup.addTo", { path: lookupParentDir })}
										</p>
										<Input
											value={lookupText}
											onChange={(e) => setLookupText(e.target.value)}
											placeholder={t("lookup.placeholder")}
											disabled={lookupBusy || importBusy}
											className="h-8 text-xs"
										/>
										{lookupError ? (
											<p className="text-destructive text-xs leading-snug">
												{lookupError}
											</p>
										) : null}
										{/* Imports bottom-left (PDF · bibliography) · Add bottom-right */}
										<div className="flex items-center justify-between gap-2">
											<div className="flex items-center gap-1">
												{onImportLocalPdf ? (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																type="button"
																variant="ghost"
																size="icon-xs"
																disabled={actionsDisabled}
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
																disabled={actionsDisabled}
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
												disabled={
													lookupBusy ||
													importBusy ||
													importPdfBusy ||
													!lookupText.trim()
												}
											>
												{lookupBusy ? t("lookup.adding") : t("lookup.add")}
											</Button>
										</div>
									</form>
								</PopoverContent>
							</Popover>
							<IconAction
								label={t("fileTree.newFile")}
								onClick={onNewFile}
								disabled={actionsDisabled}
							>
								<FilePlus2 className="size-3.5" />
							</IconAction>
							<IconAction
								label={t("fileTree.newFolder")}
								onClick={onNewFolder}
								disabled={actionsDisabled}
							>
								<FolderPlus className="size-3.5" />
							</IconAction>
						</>
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
													host: entry.host,
													user: entry.user,
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
												<span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
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
											{p}
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
}
