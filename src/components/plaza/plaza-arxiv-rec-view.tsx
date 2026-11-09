import { SelectionSurface } from "@/components/selection/selection-surface";
/**
 * Native 广场 panel: today's arXiv papers ranked against the Vault library.
 *
 * The Host caches its same-day run, so opening this panel renders the stored
 * result first and only recomputes when the categories change or on request.
 *
 * Before showing anything we probe the user's configured embedding endpoint
 * (POST /embeddings with one tiny input). Until the probe passes, the panel
 * hides the stored cache so the user never sees "stale results from a setup
 * that no longer works" — they get a direct route to the settings page.
 */

import {
	BookOpen,
	Check,
	Download,
	ExternalLink,
	Languages,
	Loader2,
	Plus,
	RefreshCw,
	RotateCw,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatLocaleTimestamp } from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { cn } from "@/lib/core/utils";
import { lookupSubmit } from "@/lib/paper/import-actions";
import { ARXIV_ALL_CATEGORIES, ARXIV_FEED_CHIPS } from "@/lib/plaza/feeds";
import {
	isEmptyCorpusError,
	isNoCandidatesError,
	isNoEmbeddingError,
	isProbeFailedError,
	probeEmbedding,
	type RecommendItem,
	recommendArxiv,
	recommendArxivLast,
} from "@/lib/recommend";
import type { EmbeddingSettings } from "@/lib/settings";
import { loadSettings, subscribeSettings } from "@/lib/settings/store";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { runTranslate } from "@/lib/translate";
import { getVaultPath } from "@/lib/vault/store";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

const CATEGORIES_STORAGE_KEY = "plaza:arxiv-rec:categories";

function loadCategories(): string[] {
	const parsed = readJsonStorage<unknown>(CATEGORIES_STORAGE_KEY, null);
	if (Array.isArray(parsed) && parsed.length > 0) return parsed;
	return [...ARXIV_FEED_CHIPS];
}

function persistCategories(categories: string[]) {
	writeJsonStorage(CATEGORIES_STORAGE_KEY, categories);
}

/** Empty-state reason, so the panel can offer the matching next action. */
type EmptyReason =
	| "noEmbedding"
	| "probeFailed"
	| "emptyCorpus"
	| "noCandidates"
	| null;

/** Gate for showing the stored run or running recompute. */
type ProbeStatus = "pending" | "unconfigured" | "ok" | "failed";

/** Snapshot of the embedding config used to decide whether to re-probe. */
function embeddingProbeKey(e: EmbeddingSettings): string {
	return `${e.source}|${e.baseUrl}|${e.apiKey}|${e.model}`;
}

function readEmbeddingKey(): string {
	return embeddingProbeKey(loadSettings().embedding);
}

export function PlazaArxivRecView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [items, setItems] = useState<RecommendItem[]>([]);
	const [categories, setCategories] = useState<string[]>(loadCategories);
	const [computedAt, setComputedAt] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [emptyReason, setEmptyReason] = useState<EmptyReason>(null);
	const [translations, setTranslations] = useState<Record<string, string>>({});
	const [translating, setTranslating] = useState(false);
	const [probeStatus, setProbeStatus] = useState<ProbeStatus>("pending");
	const [probeError, setProbeError] = useState<string | null>(null);
	/** Bumped on every new probe; in-flight stale probes are discarded. */
	const probeTokenRef = useRef(0);
	/** Last embedding config we've probed against (re-probe on change). */
	const lastEmbeddingKeyRef = useRef<string>("");
	const loadedRef = useRef(false);

	const handleError = useCallback((error: unknown) => {
		if (isNoEmbeddingError(error)) {
			setEmptyReason("noEmbedding");
			return;
		}
		if (isProbeFailedError(error)) {
			setEmptyReason("probeFailed");
			return;
		}
		if (isEmptyCorpusError(error)) {
			setEmptyReason("emptyCorpus");
			return;
		}
		if (isNoCandidatesError(error)) {
			setEmptyReason("noCandidates");
			return;
		}
		notifyError(errorText(error));
	}, []);

	/**
	 * Probe the embedding endpoint. On success returns true; on failure updates
	 * `probeStatus`/`emptyReason` and the caller should bail. Stale results
	 * from earlier probes (token bumped underneath) are dropped.
	 */
	const runProbe = useCallback(async (): Promise<boolean> => {
		const token = ++probeTokenRef.current;
		setProbeStatus((prev) =>
			prev === "failed" || prev === "unconfigured" ? prev : "pending",
		);
		setProbeError(null);
		try {
			await probeEmbedding();
			if (token !== probeTokenRef.current) return false;
			setProbeStatus("ok");
			return true;
		} catch (error) {
			if (token !== probeTokenRef.current) return false;
			const message = errorText(error);
			const probeFailed = isProbeFailedError(error);
			setProbeError(probeFailed ? null : message);
			if (isNoEmbeddingError(error)) {
				setProbeStatus("unconfigured");
				setEmptyReason("noEmbedding");
			} else {
				setProbeStatus("failed");
				setEmptyReason("probeFailed");
				if (!probeFailed) notifyError(message);
			}
			return false;
		}
	}, []);

	/** After a successful probe, pull the same-day stored run. */
	const loadStored = useCallback(async () => {
		const vaultPath = getVaultPath();
		if (!vaultPath) return;
		try {
			const stored = await recommendArxivLast(vaultPath);
			if (!stored) return;
			setItems(stored.items);
			setComputedAt(stored.computedAt);
		} catch {
			/* no stored run yet — the user can refresh */
		}
	}, []);

	const run = useCallback(
		async (nextCategories: string[]) => {
			const vaultPath = getVaultPath();
			if (!vaultPath) return;
			setBusy(true);
			setEmptyReason(null);
			try {
				const ok = await runProbe();
				if (!ok) return;
				const result = await recommendArxiv({
					vaultPath,
					categories: nextCategories,
					force: true,
				});
				setItems(result.items);
				setComputedAt(result.computedAt);
				if (result.items.length === 0) setEmptyReason("noCandidates");
			} catch (error) {
				handleError(error);
			} finally {
				setBusy(false);
			}
		},
		[handleError, runProbe],
	);

	// First mount: probe → load stored. The vault-open prewarm keeps it current.
	useEffect(() => {
		if (loadedRef.current) return;
		loadedRef.current = true;
		lastEmbeddingKeyRef.current = readEmbeddingKey();
		void (async () => {
			const ok = await runProbe();
			if (ok) await loadStored();
		})();
	}, [loadStored, runProbe]);

	// Re-probe when the user edits the embedding config in Settings.
	useEffect(() => {
		return subscribeSettings((next) => {
			const key = embeddingProbeKey(next.embedding);
			if (key === lastEmbeddingKeyRef.current) return;
			lastEmbeddingKeyRef.current = key;
			// Drop any visible stored cache so we don't flash stale results
			// from before the user fixed their config.
			setItems([]);
			setComputedAt(null);
			setEmptyReason(null);
			void (async () => {
				const ok = await runProbe();
				if (ok) await loadStored();
			})();
		});
	}, [loadStored, runProbe]);

	const retryProbe = useCallback(() => {
		setEmptyReason(null);
		void (async () => {
			const ok = await runProbe();
			if (ok) await loadStored();
		})();
	}, [loadStored, runProbe]);

	const addCategory = useCallback(
		(category: string) => {
			if (categories.includes(category)) return;
			const next = [...categories, category];
			setCategories(next);
			persistCategories(next);
			void run(next);
		},
		[categories, run],
	);

	const removeCategory = useCallback(
		(category: string) => {
			const next = categories.filter((c) => c !== category);
			if (next.length === 0) return;
			setCategories(next);
			persistCategories(next);
			void run(next);
		},
		[categories, run],
	);

	const translateAll = useCallback(async () => {
		if (translating || items.length === 0) return;
		setTranslating(true);
		const results = await Promise.allSettled(
			items.map((item) =>
				runTranslate({
					text: item.abstract,
					context: { surface: "arxiv-rec", paperId: item.arxivId },
				}),
			),
		);
		const next: Record<string, string> = { ...translations };
		let failed = 0;
		items.forEach((item, i) => {
			const r = results[i];
			if (r.status === "fulfilled") {
				next[item.arxivId] = r.value;
			} else {
				failed += 1;
			}
		});
		setTranslations(next);
		setTranslating(false);
		if (failed > 0) {
			notifyError(
				failed === items.length
					? "Translation failed"
					: `Translation failed for ${failed} of ${items.length} papers`,
			);
		}
	}, [items, translating, translations]);

	const probeOk = probeStatus === "ok";
	const probePending = probeStatus === "pending";
	const showEmpty = items.length === 0 || !probeOk;

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2.5 py-2">
				{categories.map((category) => (
					<span
						key={category}
						className={cn(
							"group inline-flex items-center gap-0.5 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-2 pr-0.5 font-mono text-caption text-foreground",
							(busy || !probeOk) && "opacity-60",
						)}
					>
						{category}
						<button
							type="button"
							disabled={busy || categories.length <= 1 || !probeOk}
							className="rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-foreground/10"
							aria-label={t("plaza.arxivRec.removeCategory", { category })}
							onClick={(e) => {
								e.stopPropagation();
								removeCategory(category);
							}}
						>
							<X className="size-2.5" aria-hidden />
						</button>
					</span>
				))}
				<CategoryPicker
					disabled={busy || !probeOk}
					existing={categories}
					onSelect={addCategory}
				/>
				<span className="ml-auto flex items-center gap-1.5">
					{computedAt && probeOk ? (
						<span className="text-muted-foreground text-caption">
							{formatLocaleTimestamp(computedAt)}
						</span>
					) : null}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								disabled={translating || busy || items.length === 0}
								aria-label={
									translating
										? t("plaza.arxivRec.translating")
										: t("plaza.arxivRec.translate")
								}
								onClick={() => void translateAll()}
							>
								{translating ? (
									<Loader2 className="size-3.5 animate-spin" aria-hidden />
								) : (
									<Languages className="size-3.5" aria-hidden />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{translating
								? t("plaza.arxivRec.translating")
								: t("plaza.arxivRec.translate")}
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								disabled={busy || !probeOk}
								aria-label={t("plaza.arxivRec.refresh")}
								onClick={() => void run(categories)}
							>
								{busy ? (
									<Loader2 className="size-3.5 animate-spin" aria-hidden />
								) : (
									<RefreshCw className="size-3.5" aria-hidden />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("plaza.arxivRec.refresh")}</TooltipContent>
					</Tooltip>
				</span>
			</div>

			<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-2.5">
				{showEmpty ? (
					<EmptyState
						reason={emptyReason}
						busy={busy}
						probePending={probePending}
						probeError={probeError}
						onRetry={retryProbe}
					/>
				) : (
					<div className="grid gap-2">
						{items.map((item) => (
							<RecommendCard
								key={item.arxivId}
								item={item}
								translation={translations[item.arxivId]}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function EmptyState({
	reason,
	busy,
	probePending,
	probeError,
	onRetry,
}: {
	reason: EmptyReason;
	busy: boolean;
	probePending: boolean;
	probeError: string | null;
	onRetry: () => void;
}) {
	const { t } = useTranslation("sidebar");
	if (busy || probePending) {
		return (
			<div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-xs">
				<Loader2 className="size-3.5 animate-spin" aria-hidden />
				{reason === "probeFailed" || reason === "noEmbedding"
					? t("plaza.arxivRec.probing")
					: t("plaza.arxivRec.computing")}
			</div>
		);
	}
	if (reason === "noEmbedding") {
		return (
			<div className="flex flex-col items-center gap-2 py-10 text-center">
				<p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
					{t("plaza.arxivRec.needsEmbedding")}
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => openSettingsWindow("agent")}
				>
					{t("plaza.arxivRec.openSettings")}
				</Button>
			</div>
		);
	}
	if (reason === "probeFailed") {
		return (
			<div className="flex flex-col items-center gap-2 py-10 text-center">
				<p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
					{t("plaza.arxivRec.probeFailed")}
				</p>
				{probeError ? (
					<p className="max-w-sm text-muted-foreground/70 text-caption leading-relaxed">
						{probeError}
					</p>
				) : null}
				<div className="flex items-center gap-2">
					<Button type="button" variant="outline" size="sm" onClick={onRetry}>
						<RotateCw className="size-3.5" aria-hidden />
						{t("plaza.arxivRec.retry")}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => openSettingsWindow("agent")}
					>
						{t("plaza.arxivRec.openSettings")}
					</Button>
				</div>
			</div>
		);
	}
	return (
		<div className="flex flex-col items-center gap-2 py-10 text-center">
			<p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
				{reason === "emptyCorpus"
					? t("plaza.arxivRec.needsCorpus")
					: reason === "noCandidates"
						? t("plaza.arxivRec.noCandidates")
						: t("plaza.arxivRec.idle")}
			</p>
		</div>
	);
}

function RecommendCard({
	item,
	translation,
}: {
	item: RecommendItem;
	translation?: string;
}) {
	const { t } = useTranslation("sidebar");
	const [busy, setBusy] = useState(false);
	const [imported, setImported] = useState(false);

	const importPaper = useCallback(async () => {
		if (busy || imported) return;
		setBusy(true);
		try {
			await lookupSubmit([item.url], {
				onComplete: (result) => {
					const ok =
						result.imported.length > 0 ||
						result.skipped.some(
							(row) =>
								row.reason === "already_in_library" ||
								row.reason === "duplicate_in_batch",
						);
					if (ok) setImported(true);
					setBusy(false);
				},
			});
		} catch (error) {
			notifyError(errorText(error));
			setBusy(false);
		}
	}, [busy, imported, item.url]);

	return (
		<div className="group relative rounded-lg border bg-background p-2.5 pr-16 transition-colors hover:border-foreground/20 hover:bg-muted/50">
			<div className="flex items-baseline gap-2">
				<span
					className="line-clamp-2 min-w-0 flex-1 font-medium text-sm leading-snug"
					title={item.title}
				>
					{item.title}
				</span>
			</div>
			<SelectionSurface
				source={{
					sourcePath: item.url,
					sourceUrl: item.url,
					sourceTitle: item.title,
					origin: "markdown",
					surface: "abstract",
				}}
				className="mt-1 line-clamp-3 select-text text-muted-foreground text-xs leading-snug"
			>
				{translation ?? item.abstract}
			</SelectionSurface>
			<div className="absolute top-2 right-2 flex items-center gap-0.5">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("plaza.arxivRec.read")}
							onClick={() => openRemoteArxivPaper(item)}
						>
							<BookOpen className="size-3.5" aria-hidden />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("plaza.arxivRec.read")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("plaza.feeds.openOriginal")}
							onClick={() => openExternalUrl(item.url)}
						>
							<ExternalLink className="size-3.5" aria-hidden />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("plaza.feeds.openOriginal")}</TooltipContent>
				</Tooltip>
				{imported ? (
					<Check
						className="size-3.5 text-muted-foreground"
						aria-label={t("plaza.feeds.imported")}
					/>
				) : (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								disabled={busy}
								aria-label={t("plaza.feeds.import")}
								onClick={() => void importPaper()}
							>
								{busy ? (
									<Loader2 className="size-3.5 animate-spin" aria-hidden />
								) : (
									<Download className="size-3.5" aria-hidden />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("plaza.feeds.import")}</TooltipContent>
					</Tooltip>
				)}
			</div>
		</div>
	);
}

function CategoryPicker({
	disabled,
	existing,
	onSelect,
}: {
	disabled: boolean;
	existing: string[];
	onSelect: (category: string) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [open, setOpen] = useState(false);

	const filtered = useMemo(
		() => ARXIV_ALL_CATEGORIES.filter((c) => !existing.includes(c)),
		[existing],
	);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							disabled={disabled}
							className={cn(
								"inline-flex size-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground",
								disabled && "cursor-not-allowed opacity-60",
								"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							)}
							aria-label={t("plaza.arxivRec.addCategory")}
						>
							<Plus className="size-3" aria-hidden />
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>{t("plaza.arxivRec.addCategory")}</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="start"
				className="w-56 p-0"
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<Command shouldFilter={false}>
					<CommandInput
						placeholder={t("plaza.arxivRec.searchCategory")}
						className="h-8 text-xs"
					/>
					<CommandList>
						<CommandEmpty>{t("plaza.arxivRec.noCategoryMatch")}</CommandEmpty>
						<CommandGroup>
							{filtered.map((cat) => (
								<CommandItem
									key={cat}
									value={cat}
									onSelect={() => {
										onSelect(cat);
										setOpen(false);
									}}
									className="font-mono text-xs"
								>
									{cat}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
