/**
 * Vault title bar: switch vault dropdown + magic-wand import popover.
 * Stateless relative to FileTree (no shared internal state).
 */

import {
	ChevronsUpDown,
	FileUp,
	Loader2,
	Upload,
	WandSparkles,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OpenRemoteVaultArgs } from "@/components/dialogs/remote-vault-dialog";
import { PaneHeader } from "@/components/shell/pane-header";
import { VaultSwitcherMenu } from "@/components/sidebar/vault-switcher-menu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { type ChatImportExtractResult, commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import { inferLookupSource } from "@/lib/paper/import-actions";

export type VaultSidebarHeaderProps = {
	title: string;
	/** Vault-relative papers parent, e.g. `papers` or `papers/nlp` */
	lookupParentDir: string;
	/** Magic-wand submit: resolve once the inputs are queued, not imported. */
	onLookupSubmit: (texts: string[]) => Promise<void>;
	/** Chat-review confirm (#652): one batch import job for the checked rows;
	 * resolves once that job is queued. */
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
	/** Import selected papers from an AlphaXiv library. */
	onImportAlphaXiv?: () => void;
	/** Bidirectional Zotero sync (item in the vault switcher dropdown). */
	onSyncZotero?: () => void;
};

export const VaultSidebarHeader = memo(function VaultSidebarHeader({
	title,
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
	onImportAlphaXiv,
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
	const actionsDisabled =
		busy || isDemo || Boolean(importBusy) || Boolean(importPdfBusy);
	const lookupDisabled = busy || isDemo;
	const magicWandShortcut = useShortcutLabel("magicWand");

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
			if (lookupTextareaRef.current) {
				lookupTextareaRef.current.style.height = "auto";
			}
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
											className="relative"
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
											<div className="flex items-center gap-1">
												<Button
													type="submit"
													size="sm"
													className="h-7 px-2.5 text-xs"
													disabled={lookupBusy || !lookupText.trim()}
												>
													{lookupBusy ? t("lookup.adding") : t("lookup.add")}
												</Button>
											</div>
										</div>
									)}
								</form>
							</PopoverContent>
						</Popover>
					}
				>
					<VaultSwitcherMenu
						trigger={
							<button
								type="button"
								className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-muted"
								aria-label={t("app:vault.switchVault")}
							>
								<span className="truncate font-medium text-sm" title={title}>
									{title}
								</span>
								<ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
							</button>
						}
						tooltip={t("app:vault.switchVault")}
						recentVaults={recentVaults}
						vaultPath={vaultPath}
						busy={busy}
						actionsDisabled={actionsDisabled}
						onOpenRecent={onOpenRecent}
						onRemoveRecent={onRemoveRecent}
						onOpenVault={onOpenVault}
						onCreateVault={onCreateVault}
						onOpenRemoteVault={onOpenRemoteVault}
						onMigrateZotero={onMigrateZotero}
						onImportAlphaXiv={onImportAlphaXiv}
						onSyncZotero={onSyncZotero}
					/>
				</PaneHeader>
			</div>
		</TooltipProvider>
	);
});
