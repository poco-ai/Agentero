/**
 * Vault switcher menu: recent local and remote vaults, then open / connect /
 * create. Shared by the sidebar header and the Agent workspace home — the host
 * owns the trigger and passes the same actions it uses elsewhere, so every
 * surface switches vaults the same way.
 */

import {
	Check,
	FolderOpen,
	FolderPlus,
	RefreshCw,
	Server,
	X,
} from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { SiZotero } from "react-icons/si";
import {
	type OpenRemoteVaultArgs,
	RemoteVaultDialog,
} from "@/components/dialogs/remote-vault-dialog";
import { AlphaXivIcon } from "@/components/icons/paper-service-icons";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { displayPath } from "@/lib/core/path";
import { vaultDisplayName } from "@/lib/vault";
import {
	getRecentRemoteVaults,
	getRemoteSessionMeta,
	isRemoteVaultHandle,
	type RecentRemoteVault,
	removeRecentRemoteVault,
} from "@/lib/vault/remote/remote-vault";

export type VaultSwitcherMenuProps = {
	/** Element that opens the menu; it receives the trigger props and ref. */
	trigger: ReactNode;
	/** Hover text for the trigger. Omit it when the trigger says what it does. */
	tooltip?: ReactNode;
	/** Menu edge that lines up with the trigger's. */
	align?: "start" | "center" | "end";
	recentVaults: string[];
	vaultPath: string | null;
	/** A vault open or remote connect is in flight. */
	busy?: boolean;
	/** Blocks the import rows while the library is busy. */
	actionsDisabled?: boolean;
	onOpenRecent: (path: string) => void;
	onRemoveRecent: (path: string) => void;
	onOpenVault: () => void;
	onCreateVault: () => void;
	onOpenRemoteVault?: (args: OpenRemoteVaultArgs) => void | Promise<void>;
	/** Migrate from Zotero (item in the vault switcher dropdown). */
	onMigrateZotero?: () => void;
	/** Import selected papers from an AlphaXiv library. */
	onImportAlphaXiv?: () => void;
	/** Bidirectional Zotero sync (item in the vault switcher dropdown). */
	onSyncZotero?: () => void;
};

export function VaultSwitcherMenu({
	trigger,
	tooltip,
	align = "start",
	recentVaults,
	vaultPath,
	busy = false,
	actionsDisabled = false,
	onOpenRecent,
	onRemoveRecent,
	onOpenVault,
	onCreateVault,
	onOpenRemoteVault,
	onMigrateZotero,
	onImportAlphaXiv,
	onSyncZotero,
}: VaultSwitcherMenuProps) {
	const { t } = useTranslation(["app", "sidebar"]);
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

	return (
		<>
			<DropdownMenu
				onOpenChange={(open) => {
					if (open) refreshRecentRemotes();
				}}
			>
				{tooltip ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
						</TooltipTrigger>
						<TooltipContent side="bottom">{tooltip}</TooltipContent>
					</Tooltip>
				) : (
					<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
				)}
				<DropdownMenuContent align={align} className="w-72">
					<DropdownMenuLabel>{t("app:vault.recentTitle")}</DropdownMenuLabel>
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
					{onMigrateZotero || onImportAlphaXiv || onSyncZotero ? (
						<DropdownMenuSeparator />
					) : null}
					{onImportAlphaXiv ? (
						<DropdownMenuItem
							disabled={actionsDisabled}
							onSelect={() => {
								requestAnimationFrame(() => onImportAlphaXiv());
							}}
						>
							<AlphaXivIcon className="size-3.5 shrink-0 text-[#B33131]" />
							{t("sidebar:alphaxivImport.button")}
						</DropdownMenuItem>
					) : null}
					{onMigrateZotero ? (
						<DropdownMenuItem
							disabled={actionsDisabled}
							onSelect={() => {
								requestAnimationFrame(() => onMigrateZotero());
							}}
						>
							<SiZotero className="size-3.5 text-[#CC2936]" />
							{t("sidebar:zoteroMigrate.button")}
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
							{t("sidebar:zoteroSync.button")}
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
		</>
	);
}
