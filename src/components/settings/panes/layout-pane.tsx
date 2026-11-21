import { ChevronRight, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	PROVIDER_INPUT_CLASS,
	ProbeDot,
	ProviderCard,
	ProviderCardHeader,
	ProviderFieldRow,
} from "@/components/settings/provider-card";
import {
	HelpLabel,
	PageTitle,
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import type { SettingsHostContext } from "@/components/settings/types";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { BUILTIN_PROVIDER_ID } from "@/lib/core/builtin";
import { errorMessage, notifyError, notifySuccess } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import {
	clearAndReparse,
	clearParseResults,
	type ParseResultScope,
} from "@/lib/paper/reparse";
import {
	layoutBackendsAfterClearingProvider,
	persistLayoutProviderConfig,
	probeLayoutProvider,
} from "@/lib/pdf/layout/provider-config";
import {
	hasReadyProvider,
	isProviderCardConfigurable,
	isProviderReady,
	isRemoteLayoutProvider,
	LAYOUT_PROVIDERS,
	layoutProviderCard,
	mergeProviderCards,
	PARSER_PROVIDERS,
	type ProviderCardDescriptor,
} from "@/lib/pdf/layout/providers";
import {
	DEFAULT_MINERU_LANGUAGE,
	isLayoutBackend,
	isParserBackend,
	LAYOUT_PROVIDER_DEFAULT_BASE_URLS,
	LAYOUT_PROVIDER_DOCS_URLS,
	type LayoutProviderConfig,
	type LayoutProviderId,
	MINERU_LANGUAGES,
	PARSER_BACKENDS,
	PROVIDER_MODEL_PRESETS,
} from "@/lib/pdf/layout/settings";
import type { AppSettings } from "@/lib/settings";
import type { ProbeStatus } from "@/lib/ui/probe-status";

const EMPTY_PROVIDER_CONFIG: LayoutProviderConfig = {
	apiKey: "",
	baseUrl: "",
	model: "",
	prompt: "",
	language: DEFAULT_MINERU_LANGUAGE,
	isOcr: false,
	selfHosted: false,
};

const PROBE_LABEL_KEYS = {
	ok: "layout.providerConfig.probeOk",
	fail: "layout.providerConfig.probeFail",
	probing: "layout.providerConfig.probeProbing",
	idle: "layout.providerConfig.probeIdle",
} as const satisfies Record<ProbeStatus, string>;

export function LayoutPane({
	settings,
	patch,
	vaultPath,
	hostContext,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	vaultPath?: string | null;
	hostContext: SettingsHostContext;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const layout = settings.layout;
	const isLocalVault = hostContext.kind === "local";
	const canManageResults = Boolean(vaultPath) && isLocalVault && isTauri();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogMode, setDialogMode] = useState<"clear" | "reparse">("clear");
	const [scope, setScope] = useState<ParseResultScope>("all");
	const [busy, setBusy] = useState(false);
	const [otherProvidersOpen, setOtherProvidersOpen] = useState(false);
	// All remote providers are listed for configuration, like the translate
	// pane; the backend selects only offer the configured ones (plus local).
	// Cards with no editable field (the built-in parser) render nothing.
	const cards = mergeProviderCards([
		...Object.values(LAYOUT_PROVIDERS).map((descriptor) =>
			layoutProviderCard(descriptor),
		),
		...Object.values(PARSER_PROVIDERS),
	]).filter(isProviderCardConfigurable);
	const isProviderConfigured = (id: LayoutProviderId) => {
		const card = cards.find((candidate) => candidate.id === id);
		const config = layout.providerConfigs[id];
		return Boolean(card && config && isProviderReady(card, config));
	};
	// The menus only list configured providers, so an empty menu reads as "this
	// app cannot do MinerU". Explain the ordering where the user looks first,
	// and drop the hint once any provider is usable.
	const noProviderReady = !hasReadyProvider(cards, layout.providerConfigs);
	const backendOptions = Object.values(LAYOUT_PROVIDERS).filter(
		(descriptor) => {
			if (!isRemoteLayoutProvider(descriptor)) return true;
			if (descriptor.id === layout.backend) return true;
			return isProviderConfigured(descriptor.id);
		},
	);
	const parserBackendOptions = PARSER_BACKENDS.filter((backend) => {
		if (backend === BUILTIN_PROVIDER_ID) return false;
		if (backend === "local") return true;
		return backend === layout.parserBackend || isProviderConfigured(backend);
	});
	// The built-in parser stays implemented, but it is no longer offered here.
	useEffect(() => {
		if (layout.parserBackend !== BUILTIN_PROVIDER_ID) return;
		patch({ layout: { ...layout, parserBackend: "local" } });
	}, [layout, patch]);
	// OpenAI-compatible is a catch-all: keep it collapsed under "Other" so the
	// recommended Paddle / MinerU path stays uncluttered (issue #656).
	const primaryCards = cards.filter((card) => card.id !== "openaiCompatible");
	const otherCards = cards.filter((card) => card.id === "openaiCompatible");

	const openDialog = useCallback((mode: "clear" | "reparse") => {
		setDialogMode(mode);
		setScope("all");
		setDialogOpen(true);
	}, []);

	const handleConfirm = useCallback(async () => {
		if (!vaultPath) return;
		setBusy(true);
		try {
			const result =
				dialogMode === "clear"
					? await clearParseResults(vaultPath, scope)
					: await clearAndReparse(vaultPath, scope);
			notifySuccess(
				t(
					dialogMode === "clear"
						? "layout.clearResults.clearDone"
						: "layout.clearResults.reparseDone",
					{
						scanned: result.papersScanned,
						removed: result.filesRemoved,
						layout: "layoutEnqueued" in result ? result.layoutEnqueued : 0,
						paper: "paperEnqueued" in result ? result.paperEnqueued : 0,
					},
				),
			);
			setDialogOpen(false);
		} catch (err) {
			notifyError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}, [dialogMode, scope, vaultPath, t]);

	const confirmLabel =
		dialogMode === "clear"
			? t("layout.clearResults.confirmClear")
			: t("layout.clearResults.confirmReparse");

	return (
		<div className="space-y-6">
			<PageTitle title={t("layout.title")} />

			<SettingsGroup>
				<SettingsRow label={t("layout.backend.label")} htmlFor="layout-backend">
					<Select
						value={layout.backend}
						disabled={backendOptions.length <= 1}
						onValueChange={(value) => {
							if (isLayoutBackend(value)) {
								patch({ layout: { ...layout, backend: value } });
							}
						}}
					>
						<SelectTrigger
							id="layout-backend"
							size="sm"
							className={cn(
								"min-w-[200px] max-w-[280px]",
								// Keep full opacity when the sole option is locked — avoids
								// a washed-out look and width jump vs plain text.
								backendOptions.length <= 1 &&
									"disabled:cursor-default disabled:opacity-100",
							)}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent className="max-h-72">
							{backendOptions.map((descriptor) => (
								<SelectItem key={descriptor.id} value={descriptor.id}>
									{t(
										`layout.backend.${descriptor.id}` as "layout.backend.local",
									)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label={t("layout.parserBackend.label")}
					htmlFor="layout-parser-backend"
				>
					<Select
						value={layout.parserBackend}
						disabled={parserBackendOptions.length <= 1}
						onValueChange={(value) => {
							if (isParserBackend(value)) {
								patch({ layout: { ...layout, parserBackend: value } });
							}
						}}
					>
						<SelectTrigger
							id="layout-parser-backend"
							size="sm"
							className={cn(
								"min-w-[200px] max-w-[280px]",
								parserBackendOptions.length <= 1 &&
									"disabled:cursor-default disabled:opacity-100",
							)}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent className="max-h-72">
							{parserBackendOptions.map((backend) => (
								<SelectItem key={backend} value={backend}>
									{t(
										`layout.parserBackend.${backend}` as "layout.parserBackend.local",
									)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsGroup>

			{noProviderReady ? (
				<p className="mt-3 px-0.5 text-muted-foreground text-xs">
					{t("layout.menusHint")}
				</p>
			) : null}

			<div className="mb-5">
				<h3 className="mb-2 px-0.5 font-medium text-sm">
					{t("layout.providerConfig.section")}
				</h3>
				<p className="mb-2 px-0.5 text-muted-foreground text-xs">
					{t("layout.providerConfig.sectionHint")}
				</p>
				<div className="grid gap-2">
					{primaryCards.map((card) => (
						<ProviderConfigCard
							key={card.id}
							provider={card}
							settings={settings}
							patch={patch}
						/>
					))}
				</div>
				{otherCards.length > 0 ? (
					<Collapsible
						className="mt-2"
						open={otherProvidersOpen}
						onOpenChange={setOtherProvidersOpen}
					>
						<CollapsibleTrigger asChild>
							<button
								type="button"
								className="flex items-center gap-1 rounded px-0.5 py-0.5 text-muted-foreground text-xs outline-none transition-colors hover:text-foreground"
								aria-expanded={otherProvidersOpen}
							>
								<ChevronRight
									className={cn(
										"size-3.5 transition-transform",
										otherProvidersOpen && "rotate-90",
									)}
								/>
								{t("layout.providerConfig.other")}
							</button>
						</CollapsibleTrigger>
						<CollapsibleContent className="mt-2 grid gap-2">
							{otherCards.map((card) => (
								<ProviderConfigCard
									key={card.id}
									provider={card}
									settings={settings}
									patch={patch}
								/>
							))}
						</CollapsibleContent>
					</Collapsible>
				) : null}
			</div>

			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!canManageResults || busy}
					onClick={() => openDialog("clear")}
				>
					<Trash2 data-icon="inline-start" className="size-3.5" />
					{t("layout.clearResults.clear")}
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!canManageResults || busy}
					onClick={() => openDialog("reparse")}
				>
					<RefreshCw data-icon="inline-start" className="size-3.5" />
					{t("layout.clearResults.clearAndReparse")}
				</Button>
			</div>

			<Dialog
				open={dialogOpen}
				onOpenChange={(open) => {
					if (!open && !busy) setDialogOpen(false);
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="sm:max-w-xs"
					aria-describedby={undefined}
				>
					<DialogHeader>
						<DialogTitle>
							{dialogMode === "clear"
								? t("layout.clearResults.dialog.clearTitle")
								: t("layout.clearResults.dialog.reparseTitle")}
						</DialogTitle>
					</DialogHeader>

					<div className="space-y-1.5 py-1">
						<Label className="text-xs text-muted-foreground">
							{t("layout.clearResults.dialog.scopeLabel")}
						</Label>
						<Select
							value={scope}
							onValueChange={(v) => setScope(v as ParseResultScope)}
							disabled={busy}
						>
							<SelectTrigger size="sm" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="layout">
									{t("layout.clearResults.scope.layout")}
								</SelectItem>
								<SelectItem value="paper">
									{t("layout.clearResults.scope.paper")}
								</SelectItem>
								<SelectItem value="all">
									{t("layout.clearResults.scope.all")}
								</SelectItem>
							</SelectContent>
						</Select>
						{dialogMode === "reparse" &&
						settings.translate.autoTranslateImport &&
						scope !== "paper" ? (
							<p className="pt-1 text-muted-foreground text-xs">
								{t("layout.clearResults.dialog.reparseTranslate")}
							</p>
						) : null}
					</div>

					<DialogFooter className="gap-2 sm:gap-0">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => setDialogOpen(false)}
						>
							{t("common:cancel")}
						</Button>
						<Button
							type="button"
							variant="destructive"
							size="sm"
							disabled={busy}
							onClick={() => void handleConfirm()}
						>
							{busy
								? dialogMode === "clear"
									? t("layout.clearResults.clearing")
									: t("layout.clearResults.reparsing")
								: confirmLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function ProviderConfigCard({
	provider,
	settings,
	patch,
}: {
	provider: ProviderCardDescriptor;
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	const layout = settings.layout;
	const stored = layout.providerConfigs[provider.id] ?? EMPTY_PROVIDER_CONFIG;
	const [draft, setDraft] = useState<Partial<LayoutProviderConfig>>({});
	const [status, setStatus] = useState<ProbeStatus>("idle");
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const probeAbortRef = useRef<AbortController | null>(null);

	const modelPresets = PROVIDER_MODEL_PRESETS[provider.id] ?? [];
	// Empty stored value means "use the engine default": show that default as
	// the actual input value so the card looks ready to use.
	const defaultModel = modelPresets[0] ?? "";
	const defaultBaseUrl = LAYOUT_PROVIDER_DEFAULT_BASE_URLS[provider.id] ?? "";
	const displayApiKey =
		draft.apiKey !== undefined ? draft.apiKey : stored.apiKey;
	const displayBaseUrl =
		draft.baseUrl !== undefined
			? draft.baseUrl
			: stored.baseUrl || defaultBaseUrl;
	const displayModel =
		draft.model !== undefined ? draft.model : stored.model || defaultModel;
	const displayPrompt =
		draft.prompt !== undefined ? draft.prompt : stored.prompt;
	const displayLanguage =
		draft.language !== undefined
			? draft.language
			: stored.language || DEFAULT_MINERU_LANGUAGE;
	const displayIsOcr = draft.isOcr !== undefined ? draft.isOcr : stored.isOcr;
	const displaySelfHosted =
		draft.selfHosted !== undefined ? draft.selfHosted : stored.selfHosted;
	// Usable without a key when the card points at a self-hosted endpoint.
	const configured = isProviderReady(provider, {
		apiKey: displayApiKey,
		baseUrl: displayBaseUrl,
		selfHosted: displaySelfHosted,
	});

	const runProbe = useCallback(
		(apiKey: string) => {
			if (!isTauri()) return;
			probeAbortRef.current?.abort();
			const ac = new AbortController();
			probeAbortRef.current = ac;
			setStatus("probing");
			// Mask → Host resolves the stored token; plaintext draft → test pre-save.
			void probeLayoutProvider(provider.id, apiKey).then((result) => {
				if (ac.signal.aborted) return;
				setStatus(result.ok ? "ok" : "fail");
				// The dot alone cannot say why; surface the Host's reason so a
				// failed probe is actionable instead of a silent grey dot.
				if (!result.ok && result.error) notifyError(result.error);
			});
		},
		[provider.id],
	);

	/**
	 * Persist the current card fields. A card that is not ready (no key and no
	 * self-hosted endpoint) clears the stored secret, falls backends back to
	 * local when needed, and drops the provider from the selects — clearing the
	 * input triggers this immediately (no Confirm). A ready card persists and
	 * probes, even with an empty key.
	 */
	const persistConfig = useCallback(
		async (apiKey: string) => {
			const baseUrl = provider.supportsBaseUrl ? displayBaseUrl.trim() : "";
			const model = provider.supportsModel ? displayModel.trim() : "";
			const prompt = provider.supportsPrompt ? displayPrompt.trim() : "";
			const language = provider.supportsLanguage ? displayLanguage : "";
			const isOcr = provider.supportsOcr ? displayIsOcr : false;
			const selfHosted = provider.supportsSelfHosted
				? displaySelfHosted
				: false;
			const config = {
				apiKey,
				baseUrl,
				model,
				prompt,
				language,
				isOcr,
				selfHosted,
			};
			const ready = isProviderReady(provider, config);

			if (!ready) {
				// Optimistic UI: hide from backend selects before Host round-trip.
				const cleared = layoutBackendsAfterClearingProvider(
					layout,
					provider.id,
				);
				patch({
					layout: {
						...layout,
						...cleared,
						providerConfigs: {
							...layout.providerConfigs,
							[provider.id]: { ...stored, ...config },
						},
					},
				});
				setDraft({});
				setStatus("idle");
			}

			const { displayLayout } = await persistLayoutProviderConfig({
				settings,
				provider: provider.id,
				config,
				ready,
			});
			patch({ layout: displayLayout });
			setDraft({});
			if (!ready) {
				setStatus("idle");
				return;
			}
			runProbe(apiKey);
		},
		[
			displayBaseUrl,
			displayModel,
			displayPrompt,
			displayLanguage,
			displayIsOcr,
			displaySelfHosted,
			layout,
			patch,
			provider,
			runProbe,
			settings,
			stored,
		],
	);

	const confirmProvider = useCallback(() => {
		void persistConfig(displayApiKey.trim());
	}, [displayApiKey, persistConfig]);

	useEffect(() => {
		return () => {
			probeAbortRef.current?.abort();
		};
	}, []);

	const statusLabel = t(PROBE_LABEL_KEYS[status]);

	return (
		<ProviderCard>
			<ProviderCardHeader
				left={
					<>
						<Tooltip>
							<TooltipTrigger asChild>
								<ProbeDot
									status={status}
									configured={configured}
									label={statusLabel}
								/>
							</TooltipTrigger>
							<TooltipContent>{statusLabel}</TooltipContent>
						</Tooltip>
						<span className="truncate font-medium text-sm">
							{t(
								`layout.providerConfig.providerName.${provider.id}` as "layout.providerConfig.providerName.paddle",
							)}
						</span>
						<Button
							type="button"
							variant="link"
							size="xs"
							className="-ml-1.5 h-auto shrink-0 px-1.5 text-primary"
							onClick={() =>
								openExternalUrl(LAYOUT_PROVIDER_DOCS_URLS[provider.id])
							}
						>
							<ExternalLink data-icon="inline-start" className="size-3" />
							{t("layout.providerConfig.openDocsLabel")}
						</Button>
					</>
				}
				right={
					<Button
						type="button"
						variant="outline"
						size="xs"
						disabled={status === "probing"}
						onClick={() => void confirmProvider()}
					>
						{t("layout.providerConfig.confirm")}
					</Button>
				}
			/>

			<div className="space-y-2">
				{provider.requiresApiKey ? (
					<ProviderFieldRow
						label={t("layout.providerConfig.apiKey.label")}
						htmlFor={`layout-provider-${provider.id}-api-key`}
					>
						<Input
							id={`layout-provider-${provider.id}-api-key`}
							type="password"
							value={displayApiKey}
							placeholder={t(
								`layout.providerConfig.apiKey.placeholder.${provider.id}` as "layout.providerConfig.apiKey.placeholder.paddle",
							)}
							className={PROVIDER_INPUT_CLASS}
							spellCheck={false}
							autoComplete="off"
							onChange={(e) => {
								const next = e.target.value;
								if (!next.trim()) {
									setDraft((prev) => ({ ...prev, apiKey: "" }));
									// Clear immediately — do not wait for Confirm.
									if (
										stored.apiKey.trim() ||
										(isLayoutBackend(provider.id) &&
											layout.backend === provider.id) ||
										(isParserBackend(provider.id) &&
											layout.parserBackend === provider.id)
									) {
										void persistConfig("");
									} else {
										setStatus("idle");
									}
									return;
								}
								setDraft((prev) => ({ ...prev, apiKey: next }));
							}}
							onFocus={(e) => e.target.select()}
						/>
					</ProviderFieldRow>
				) : null}
				{provider.supportsBaseUrl ? (
					<ProviderFieldRow
						label={
							provider.supportsSelfHosted ? (
								<HelpLabel
									label={t("layout.providerConfig.baseUrl.label")}
									help={t("layout.providerConfig.selfHostedHelp")}
								/>
							) : (
								t("layout.providerConfig.baseUrl.label")
							)
						}
						htmlFor={`layout-provider-${provider.id}-base-url`}
					>
						<Input
							id={`layout-provider-${provider.id}-base-url`}
							type="text"
							value={displayBaseUrl}
							placeholder={LAYOUT_PROVIDER_DEFAULT_BASE_URLS[provider.id]}
							className={PROVIDER_INPUT_CLASS}
							spellCheck={false}
							autoComplete="off"
							onChange={(e) =>
								setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))
							}
						/>
					</ProviderFieldRow>
				) : null}
				{provider.supportsModel ? (
					<ProviderFieldRow
						label={t("layout.providerConfig.model.label")}
						htmlFor={`layout-provider-${provider.id}-model`}
					>
						<Input
							id={`layout-provider-${provider.id}-model`}
							type="text"
							value={displayModel}
							placeholder={modelPresets[0]}
							list={`layout-provider-${provider.id}-model-presets`}
							className={PROVIDER_INPUT_CLASS}
							spellCheck={false}
							autoComplete="off"
							onChange={(e) =>
								setDraft((prev) => ({ ...prev, model: e.target.value }))
							}
						/>
						<datalist id={`layout-provider-${provider.id}-model-presets`}>
							{modelPresets.map((preset) => (
								<option key={preset} value={preset} />
							))}
						</datalist>
					</ProviderFieldRow>
				) : null}
				{provider.supportsPrompt ? (
					<ProviderFieldRow
						label={t("layout.providerConfig.prompt.label")}
						htmlFor={`layout-provider-${provider.id}-prompt`}
					>
						<Input
							id={`layout-provider-${provider.id}-prompt`}
							type="text"
							value={displayPrompt}
							placeholder={t("layout.providerConfig.prompt.placeholder")}
							className={PROVIDER_INPUT_CLASS}
							spellCheck={false}
							autoComplete="off"
							onChange={(e) =>
								setDraft((prev) => ({ ...prev, prompt: e.target.value }))
							}
						/>
					</ProviderFieldRow>
				) : null}
				{provider.supportsLanguage ||
				provider.supportsOcr ||
				provider.supportsSelfHosted ? (
					<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
						<CollapsibleTrigger asChild>
							<button
								type="button"
								className="flex items-center gap-1 text-muted-foreground text-xs outline-none transition-colors hover:text-foreground"
								aria-label={t("layout.providerConfig.advanced")}
							>
								<ChevronRight
									className={cn(
										"size-3.5 transition-transform",
										advancedOpen && "rotate-90",
									)}
								/>
								{t("layout.providerConfig.advanced")}
							</button>
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-2 pt-2">
							{provider.supportsLanguage ? (
								<ProviderFieldRow
									label={
										<HelpLabel
											label={t("layout.providerConfig.language.label")}
											help={t("layout.providerConfig.language.help")}
										/>
									}
									htmlFor={`layout-provider-${provider.id}-language`}
								>
									<Select
										value={displayLanguage}
										onValueChange={(value) =>
											setDraft((prev) => ({ ...prev, language: value }))
										}
									>
										<SelectTrigger
											id={`layout-provider-${provider.id}-language`}
											size="sm"
											className="h-8 min-w-32 max-w-44 text-xs"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent className="max-h-72">
											{MINERU_LANGUAGES.map((language) => (
												<SelectItem key={language} value={language}>
													{t(
														`layout.providerConfig.language.options.${language}` as "layout.providerConfig.language.options.en",
													)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</ProviderFieldRow>
							) : null}
							{provider.supportsOcr ? (
								<ProviderFieldRow
									label={
										<HelpLabel
											label={t("layout.providerConfig.forceOcr.label")}
											help={t("layout.providerConfig.forceOcr.help")}
										/>
									}
									htmlFor={`layout-provider-${provider.id}-force-ocr`}
								>
									<Switch
										id={`layout-provider-${provider.id}-force-ocr`}
										size="sm"
										checked={displayIsOcr}
										onCheckedChange={(checked) =>
											setDraft((prev) => ({
												...prev,
												isOcr: checked === true,
											}))
										}
									/>
								</ProviderFieldRow>
							) : null}
							{provider.supportsSelfHosted ? (
								<ProviderFieldRow
									label={
										<HelpLabel
											label={t("layout.providerConfig.selfHosted.label")}
											help={t("layout.providerConfig.selfHosted.help")}
										/>
									}
									htmlFor={`layout-provider-${provider.id}-self-hosted`}
								>
									<Switch
										id={`layout-provider-${provider.id}-self-hosted`}
										size="sm"
										checked={displaySelfHosted}
										onCheckedChange={(checked) =>
											setDraft((prev) => ({
												...prev,
												selfHosted: checked === true,
											}))
										}
									/>
								</ProviderFieldRow>
							) : null}
						</CollapsibleContent>
					</Collapsible>
				) : null}
			</div>
		</ProviderCard>
	);
}
