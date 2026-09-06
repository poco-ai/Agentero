import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AgentModelSelects,
	useAgentModelCatalog,
} from "@/components/settings/agent-model-picker";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
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
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import type {
	AppSettings,
	CommercialTranslateProviderId,
	TranslateProviderConfig,
	TranslateProviderId,
	TranslateTargetLang,
} from "@/lib/settings";
import { saveSettingsAsync } from "@/lib/settings";
import {
	COMMERCIAL_MT_DEFAULT_BASE_URLS,
	COMMERCIAL_MT_DOCS_URLS,
	COMMERCIAL_MT_PROVIDER_IDS,
	type CommercialMtProbeMap,
	FREE_MT_PROVIDER_IDS,
	type FreeMtProbeMap,
	type FreeMtProbeStatus,
	hasTranslateApiKey,
	isCommercialProviderConfigured,
	isCommercialTranslateProvider,
	isFreeMtProvider,
	isTranslateApiKeyMask,
	listSelectableProviders,
	maskTranslateApiKey,
	probeCommercialMtProvider,
	probeFreeMtProviders,
} from "@/lib/translate";

function openExternalUrl(url: string): void {
	void import("@tauri-apps/plugin-opener")
		.then(({ openUrl }) => openUrl(url))
		.catch(() => {
			window.open(url, "_blank", "noopener,noreferrer");
		});
}

const EMPTY_PROVIDER_CONFIG: TranslateProviderConfig = {
	apiKey: "",
	baseUrl: "",
	region: "",
	model: "",
};

/** Resolve API key for save/probe: draft wins; otherwise keep stored (may be mask). */
function resolveApiKeyDraft(draft: string | undefined, stored: string): string {
	if (draft !== undefined) return draft.trim();
	return stored.trim();
}

type ProviderStatusKind = FreeMtProbeStatus | "unconfigured";

function providerStatusDotClass(kind: ProviderStatusKind): string {
	switch (kind) {
		case "ok":
			return "bg-emerald-500";
		case "fail":
			return "bg-destructive";
		case "probing":
			return "bg-amber-500 animate-pulse";
		case "unconfigured":
			return "bg-muted-foreground/35";
		default:
			// idle — configured but not checked yet
			return "bg-muted-foreground/50";
	}
}

function ProviderStatusDot({
	kind,
	label,
}: {
	kind: ProviderStatusKind;
	label: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="status"
					aria-label={label}
					className={cn(
						"inline-block size-1.5 shrink-0 rounded-full",
						providerStatusDotClass(kind),
					)}
				/>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function probeStatusLabelKey(status: FreeMtProbeStatus): string {
	switch (status) {
		case "ok":
			return "translate.provider.probeOk";
		case "fail":
			return "translate.provider.probeFail";
		case "probing":
			return "translate.provider.probeProbing";
		default:
			return "translate.provider.probeIdle";
	}
}

export function TranslatePane({
	settings,
	patch,
	onOpenAgentSettings,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	onOpenAgentSettings?: () => void;
}) {
	const { t } = useTranslation("settings");
	const tr = settings.translate;
	const patchTranslate = useCallback(
		(partial: Partial<typeof tr>) =>
			patch({ translate: { ...tr, ...partial } }),
		[patch, tr],
	);
	const showAgent = tr.provider === "agent";
	const getProviderConfig = useCallback(
		(id: CommercialTranslateProviderId): TranslateProviderConfig =>
			tr.providerConfigs[id] ?? EMPTY_PROVIDER_CONFIG,
		[tr.providerConfigs],
	);
	/** Free MT + Agent always; commercial only when configured (or currently selected). */
	const providers = useMemo(
		() =>
			listSelectableProviders().filter((s) => {
				if (!isCommercialTranslateProvider(s.id)) return true;
				if (tr.provider === s.id) return true;
				return isCommercialProviderConfigured(s.id, getProviderConfig(s.id));
			}),
		[getProviderConfig, tr.provider],
	);
	/** Free-MT probe status (Agent never probed here). */
	const [probeMap, setProbeMap] = useState<FreeMtProbeMap>({});
	const probeAbortRef = useRef<AbortController | null>(null);
	const probingRef = useRef(false);
	const [commercialProbeMap, setCommercialProbeMap] =
		useState<CommercialMtProbeMap>({});
	const commercialProbeAbortRef = useRef<
		Partial<Record<CommercialTranslateProviderId, AbortController>>
	>({});
	/** In-progress edits (API key, base URL, …) not written until Confirm. */
	const [configDrafts, setConfigDrafts] = useState<
		Partial<
			Record<CommercialTranslateProviderId, Partial<TranslateProviderConfig>>
		>
	>({});
	const setDraftField = useCallback(
		(
			providerId: CommercialTranslateProviderId,
			partial: Partial<TranslateProviderConfig>,
		) => {
			setConfigDrafts((prev) => ({
				...prev,
				[providerId]: { ...prev[providerId], ...partial },
			}));
		},
		[],
	);

	const agentModelValue = useMemo(
		() => ({ agentId: tr.agentId, modelId: tr.modelId }),
		[tr.agentId, tr.modelId],
	);
	const onAgentModelChange = useCallback(
		(next: { agentId: string; modelId: string }) => {
			patchTranslate(next);
		},
		[patchTranslate],
	);
	const agentModelCatalog = useAgentModelCatalog({
		active: showAgent,
		value: agentModelValue,
		onChange: onAgentModelChange,
	});

	/** Parallel free-MT probe when the default-service Select opens. */
	const runFreeMtProbe = useCallback(() => {
		if (!isTauri() || probingRef.current) return;
		probingRef.current = true;
		probeAbortRef.current?.abort();
		const ac = new AbortController();
		probeAbortRef.current = ac;

		const initial: FreeMtProbeMap = {};
		for (const id of FREE_MT_PROVIDER_IDS) {
			initial[id] = "probing";
		}
		setProbeMap(initial);

		void probeFreeMtProviders({
			signal: ac.signal,
			onResult: (id, ok) => {
				if (ac.signal.aborted) return;
				setProbeMap((prev) => ({
					...prev,
					[id]: ok ? "ok" : "fail",
				}));
			},
		}).finally(() => {
			if (probeAbortRef.current === ac) {
				probingRef.current = false;
			}
		});
	}, []);

	const runCommercialProbe = useCallback(
		(
			providerId: CommercialTranslateProviderId,
			configOverride?: TranslateProviderConfig,
		) => {
			const config = configOverride ?? getProviderConfig(providerId);
			if (!isCommercialProviderConfigured(providerId, config)) {
				setCommercialProbeMap((prev) => ({ ...prev, [providerId]: "idle" }));
				return;
			}

			commercialProbeAbortRef.current[providerId]?.abort();
			const ac = new AbortController();
			commercialProbeAbortRef.current[providerId] = ac;
			setCommercialProbeMap((prev) => ({
				...prev,
				[providerId]: "probing",
			}));

			void probeCommercialMtProvider(providerId, {
				config,
				signal: ac.signal,
			})
				.then((ok) => {
					if (ac.signal.aborted) return;
					setCommercialProbeMap((prev) => ({
						...prev,
						[providerId]: ok ? "ok" : "fail",
					}));
				})
				.catch(() => {
					if (ac.signal.aborted) return;
					setCommercialProbeMap((prev) => ({
						...prev,
						[providerId]: "fail",
					}));
				})
				.finally(() => {
					if (commercialProbeAbortRef.current[providerId] === ac) {
						delete commercialProbeAbortRef.current[providerId];
					}
				});
		},
		[getProviderConfig],
	);

	/** Confirm: persist drafts (key kept secret by Host), mask UI, then probe. */
	const confirmCommercialProvider = useCallback(
		async (providerId: CommercialTranslateProviderId) => {
			const stored = getProviderConfig(providerId);
			const draft = configDrafts[providerId];
			const draftOrStored = resolveApiKeyDraft(draft?.apiKey, stored.apiKey);
			// Retype → new plaintext; still showing mask → send mask so Host merge keeps secret.
			const toSave: TranslateProviderConfig = {
				...stored,
				...draft,
				apiKey: draftOrStored,
			};
			if (!isCommercialProviderConfigured(providerId, toSave)) {
				setCommercialProbeMap((prev) => ({ ...prev, [providerId]: "idle" }));
				return;
			}

			const displayMask = isTranslateApiKeyMask(toSave.apiKey)
				? toSave.apiKey
				: maskTranslateApiKey(toSave.apiKey);
			const nextTranslate = {
				...tr,
				providerConfigs: {
					...tr.providerConfigs,
					[providerId]: toSave,
				},
			};
			const maskedCfg: TranslateProviderConfig = {
				...toSave,
				apiKey: displayMask,
			};

			setConfigDrafts((prev) => {
				const next = { ...prev };
				delete next[providerId];
				return next;
			});

			try {
				// Write real key (or mask-merge) to Host before probe.
				await saveSettingsAsync({
					...settings,
					translate: nextTranslate,
				});
			} catch {
				// Still try probe / mask UI below.
			}

			// React state shows same-length `*` only; second save merges mask → keep secret.
			patch({
				translate: {
					...nextTranslate,
					providerConfigs: {
						...nextTranslate.providerConfigs,
						[providerId]: maskedCfg,
					},
				},
			});

			runCommercialProbe(providerId, maskedCfg);
		},
		[configDrafts, getProviderConfig, patch, runCommercialProbe, settings, tr],
	);

	/** Probe configured commercial engines when the default-service Select opens. */
	const runConfiguredCommercialProbes = useCallback(() => {
		if (!isTauri()) return;
		for (const id of COMMERCIAL_MT_PROVIDER_IDS) {
			if (isCommercialProviderConfigured(id, getProviderConfig(id))) {
				runCommercialProbe(id);
			}
		}
	}, [getProviderConfig, runCommercialProbe]);

	useEffect(() => {
		return () => {
			probeAbortRef.current?.abort();
			for (const ac of Object.values(commercialProbeAbortRef.current)) {
				ac?.abort();
			}
		};
	}, []);

	return (
		<>
			<PageTitle title={t("translate.title")} />
			<SettingsGroup>
				<SettingsRow label={t("translate.provider.label")}>
					<Select
						value={tr.provider}
						onValueChange={(v) =>
							patchTranslate({ provider: v as TranslateProviderId })
						}
						onOpenChange={(open) => {
							if (!open) return;
							runFreeMtProbe();
							runConfiguredCommercialProbes();
						}}
					>
						<SelectTrigger size="sm" className="min-w-[200px] max-w-[280px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent className="max-h-72">
							{providers.map((s) => {
								const status: FreeMtProbeStatus | undefined = isFreeMtProvider(
									s.id,
								)
									? (probeMap[s.id] ?? "idle")
									: isCommercialTranslateProvider(s.id)
										? (commercialProbeMap[s.id] ?? "idle")
										: undefined;
								const statusLabel =
									status != null
										? t(
												probeStatusLabelKey(
													status,
												) as "translate.provider.probeIdle",
											)
										: null;
								return (
									<SelectItem key={s.id} value={s.id}>
										<span className="flex min-w-0 items-center gap-1.5">
											{status != null && statusLabel != null ? (
												<ProviderStatusDot kind={status} label={statusLabel} />
											) : null}
											<span className="truncate">
												{t(
													`translate.provider.${s.nameKey}` as "translate.provider.google",
												)}
											</span>
										</span>
									</SelectItem>
								);
							})}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("translate.targetLang.label")}>
					<Select
						value={tr.targetLang}
						onValueChange={(v) =>
							patchTranslate({ targetLang: v as TranslateTargetLang })
						}
					>
						<SelectTrigger size="sm" className="min-w-[160px] max-w-[220px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="ui">{t("translate.targetLang.ui")}</SelectItem>
							<SelectItem value="en">{t("translate.targetLang.en")}</SelectItem>
							<SelectItem value="zh-CN">
								{t("translate.targetLang.zhCN")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label={t("translate.autoSelection.label")}
					htmlFor="translate-auto-selection"
				>
					<Switch
						id="translate-auto-selection"
						checked={tr.autoTranslateSelection}
						onCheckedChange={(v) =>
							patchTranslate({ autoTranslateSelection: v })
						}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("translate.dualPane.label")}
					htmlFor="translate-dual-pane"
				>
					<Switch
						id="translate-dual-pane"
						checked={tr.dualPaneTranslate}
						onCheckedChange={(v) => patchTranslate({ dualPaneTranslate: v })}
					/>
				</SettingsRow>
			</SettingsGroup>

			<div className="mb-5">
				<h3 className="mb-2 px-0.5 font-medium text-sm">
					{t("translate.providerConfig.section")}
				</h3>
				<div className="grid gap-2">
					{COMMERCIAL_MT_PROVIDER_IDS.map((id) => {
						const cfg = getProviderConfig(id);
						const draft = configDrafts[id];
						const draftKey = draft?.apiKey;
						const displayApiKey =
							draftKey !== undefined
								? draftKey
								: hasTranslateApiKey(cfg.apiKey)
									? isTranslateApiKeyMask(cfg.apiKey)
										? cfg.apiKey
										: maskTranslateApiKey(cfg.apiKey)
									: "";
						const effectiveCfg: TranslateProviderConfig = {
							...cfg,
							...draft,
							apiKey: resolveApiKeyDraft(draftKey, cfg.apiKey),
						};
						const configured = isCommercialProviderConfigured(id, effectiveCfg);
						const status = commercialProbeMap[id] ?? "idle";
						const statusKind: ProviderStatusKind = configured
							? status
							: "unconfigured";
						const statusLabel = configured
							? t(probeStatusLabelKey(status) as "translate.provider.probeIdle")
							: t("translate.providerConfig.notConfigured");
						const inputPrefix = `translate-provider-${id}`;
						return (
							<div key={id} className="rounded-lg border bg-card px-3 py-2.5">
								<div className="mb-2 flex items-center justify-between gap-2">
									<div className="flex min-w-0 items-center gap-1.5">
										<ProviderStatusDot kind={statusKind} label={statusLabel} />
										<p className="min-w-0 truncate font-medium text-[13px]">
											{t(
												`translate.provider.${id}` as "translate.provider.google",
											)}
										</p>
										<Button
											type="button"
											variant="link"
											size="xs"
											className="-ml-1.5 h-auto shrink-0 px-1.5 text-primary"
											onClick={() =>
												openExternalUrl(COMMERCIAL_MT_DOCS_URLS[id])
											}
										>
											<ExternalLink
												data-icon="inline-start"
												className="size-3"
											/>
											{t("translate.providerConfig.openDocsLabel")}
										</Button>
									</div>
									<Button
										type="button"
										variant="outline"
										size="xs"
										disabled={!configured || status === "probing"}
										onClick={() => void confirmCommercialProvider(id)}
									>
										{t("translate.providerConfig.confirm")}
									</Button>
								</div>

								<div className="grid gap-1.5">
									<div className="flex items-center gap-2">
										<Label
											htmlFor={`${inputPrefix}-api-key`}
											className="w-20 shrink-0 font-normal text-muted-foreground text-xs"
										>
											{t("translate.providerConfig.apiKey.label")}
										</Label>
										<Input
											id={`${inputPrefix}-api-key`}
											type="password"
											value={displayApiKey}
											onChange={(e) => {
												const next = e.target.value;
												const shownMask =
													draftKey === undefined &&
													hasTranslateApiKey(cfg.apiKey)
														? isTranslateApiKeyMask(cfg.apiKey)
															? cfg.apiKey
															: maskTranslateApiKey(cfg.apiKey)
														: null;
												// Typing over the mask starts a fresh draft (not mask + chars).
												if (
													shownMask != null &&
													(next === shownMask || next.startsWith(shownMask))
												) {
													const stripped = next.startsWith(shownMask)
														? next.slice(shownMask.length)
														: next;
													setDraftField(id, { apiKey: stripped });
													return;
												}
												setDraftField(id, { apiKey: next });
											}}
											onFocus={(e) => {
												// Select mask so the next keystroke replaces it entirely.
												if (
													draftKey === undefined &&
													hasTranslateApiKey(cfg.apiKey)
												) {
													e.currentTarget.select();
												}
											}}
											placeholder={t(
												"translate.providerConfig.apiKey.placeholder",
											)}
											className="h-8 min-w-0 flex-1 font-mono text-xs placeholder:text-muted-foreground/50"
											spellCheck={false}
											autoComplete="off"
										/>
									</div>
									<div className="flex items-center gap-2">
										<Label
											htmlFor={`${inputPrefix}-base-url`}
											className="w-20 shrink-0 font-normal text-muted-foreground text-xs"
										>
											{t("translate.providerConfig.baseUrl.label")}
										</Label>
										<Input
											id={`${inputPrefix}-base-url`}
											value={effectiveCfg.baseUrl}
											onChange={(e) =>
												setDraftField(id, { baseUrl: e.target.value })
											}
											onBlur={() => {
												const trimmed = effectiveCfg.baseUrl
													.trim()
													.replace(/\/+$/, "");
												if (trimmed !== effectiveCfg.baseUrl) {
													setDraftField(id, { baseUrl: trimmed });
												}
											}}
											placeholder={COMMERCIAL_MT_DEFAULT_BASE_URLS[id]}
											className="h-8 min-w-0 flex-1 font-mono text-xs placeholder:text-muted-foreground/50"
											spellCheck={false}
											autoComplete="off"
										/>
									</div>
									{id === "azure" ? (
										<div className="flex items-center gap-2">
											<Label
												htmlFor={`${inputPrefix}-region`}
												className="w-20 shrink-0 font-normal text-muted-foreground text-xs"
											>
												{t("translate.providerConfig.region.label")}
											</Label>
											<Input
												id={`${inputPrefix}-region`}
												value={effectiveCfg.region}
												onChange={(e) =>
													setDraftField(id, {
														region: e.target.value,
													})
												}
												placeholder={t(
													"translate.providerConfig.region.placeholder",
												)}
												className="h-8 min-w-0 flex-1 font-mono text-xs placeholder:text-muted-foreground/50"
												spellCheck={false}
												autoComplete="off"
											/>
										</div>
									) : null}
									{id === "openaiCompatible" ? (
										<div className="flex items-center gap-2">
											<Label
												htmlFor={`${inputPrefix}-model`}
												className="w-20 shrink-0 font-normal text-muted-foreground text-xs"
											>
												{t("translate.providerConfig.model.label")}
											</Label>
											<Input
												id={`${inputPrefix}-model`}
												value={effectiveCfg.model}
												onChange={(e) =>
													setDraftField(id, {
														model: e.target.value,
													})
												}
												placeholder={t(
													"translate.providerConfig.model.placeholder",
												)}
												className="h-8 min-w-0 flex-1 font-mono text-xs placeholder:text-muted-foreground/50"
												spellCheck={false}
												autoComplete="off"
											/>
										</div>
									) : null}
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{showAgent && (
				<>
					<SettingsGroup>
						{agentModelCatalog.availableAgents.length === 0 && isTauri() ? (
							<div className="flex flex-col gap-2 px-3.5 py-2.5">
								<p className="text-muted-foreground text-xs leading-relaxed">
									{t("translate.agentId.empty")}
								</p>
								{onOpenAgentSettings && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="w-fit"
										onClick={onOpenAgentSettings}
									>
										{t("translate.agentId.openAgentSettings")}
									</Button>
								)}
							</div>
						) : !isTauri() ? (
							<div className="px-3.5 py-2.5 text-muted-foreground text-xs">
								{t("agent.desktopOnly")}
							</div>
						) : (
							<AgentModelSelects
								value={agentModelValue}
								onChange={onAgentModelChange}
								agentSelectValue={agentModelCatalog.agentSelectValue}
								modelSelectValue={agentModelCatalog.modelSelectValue}
								availableAgents={agentModelCatalog.availableAgents}
								defaultAgent={agentModelCatalog.defaultAgent}
								models={agentModelCatalog.models}
								agentLabel={t("translate.agentId.label")}
								modelLabel={t("translate.modelId.label")}
								followDefaultLabel={t("translate.agentId.followDefault")}
								followDefaultNamedLabel={(name) =>
									t("translate.agentId.followDefaultNamed", { name })
								}
								followModelLabel={t("translate.modelId.followAgent")}
							/>
						)}
					</SettingsGroup>
					{agentModelCatalog.availableAgents.length > 0 &&
					agentModelCatalog.models.length === 0 ? (
						<p className="mb-3 px-0.5 text-muted-foreground text-xs leading-relaxed">
							{t("translate.modelId.needWarm")}
						</p>
					) : null}
				</>
			)}
		</>
	);
}
