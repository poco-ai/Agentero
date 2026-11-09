import {
	ExternalLink,
	KeyRound,
	LoaderCircle,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChoiceCard } from "@/components/onboarding/choice-card";
import { ProbeDot } from "@/components/settings/provider-card";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import type {
	AppSettings,
	CommercialTranslateProviderId,
	TranslateProviderConfig,
} from "@/lib/settings";
import { saveSettingsAsync } from "@/lib/settings";
import {
	COMMERCIAL_MT_DEFAULT_BASE_URLS,
	COMMERCIAL_MT_DOCS_URLS,
	COMMERCIAL_MT_PROVIDER_IDS,
	isCommercialTranslateProvider,
	probeCommercialMtProvider,
} from "@/lib/translate";
import {
	DEFAULT_TRANSLATE_SETTINGS,
	EMPTY_TRANSLATE_PROVIDER_CONFIG,
} from "@/lib/translate/defaults";
import type { ProbeStatus } from "@/lib/ui/probe-status";

const FIRST_COMMERCIAL_PROVIDER: CommercialTranslateProviderId = "deepl";

const PROBE_LABEL_KEYS = {
	ok: "translate.probeOk",
	fail: "translate.probeFail",
	probing: "translate.probeProbing",
	idle: "translate.probeIdle",
} as const satisfies Record<ProbeStatus, string>;

export function TranslateStep({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation(["onboarding", "settings"]);
	const tr = settings.translate;
	const isCommercial = isCommercialTranslateProvider(tr.provider);
	const [providerId, setProviderId] = useState<CommercialTranslateProviderId>(
		isCommercialTranslateProvider(tr.provider)
			? tr.provider
			: FIRST_COMMERCIAL_PROVIDER,
	);
	const stored = tr.providerConfigs[providerId];
	const [configureOpen, setConfigureOpen] = useState(false);
	const [draft, setDraft] = useState<{ apiKey?: string; baseUrl?: string }>({});
	const [probe, setProbe] = useState<ProbeStatus>("idle");

	const enterConfigure = () => {
		const id = isCommercialTranslateProvider(tr.provider)
			? tr.provider
			: FIRST_COMMERCIAL_PROVIDER;
		setProviderId(id);
		setDraft({});
		setProbe("idle");
		openExternalUrl(COMMERCIAL_MT_DOCS_URLS[id]);
	};

	const chooseSystemDefault = () => {
		patch({
			translate: {
				...tr,
				provider: DEFAULT_TRANSLATE_SETTINGS.provider,
			},
		});
	};

	const displayKey =
		draft.apiKey !== undefined ? draft.apiKey : (stored?.apiKey ?? "");
	const displayBaseUrl =
		draft.baseUrl !== undefined ? draft.baseUrl : (stored?.baseUrl ?? "");

	const onProviderChange = (value: string) => {
		if (!isCommercialTranslateProvider(value)) return;
		setProviderId(value);
		setDraft({});
		setProbe("idle");
	};

	const confirmCommercial = async () => {
		const pid = providerId;
		const storedCfg =
			tr.providerConfigs[pid] ?? EMPTY_TRANSLATE_PROVIDER_CONFIG;
		const apiKey = (draft.apiKey ?? storedCfg.apiKey).trim();
		const baseUrl = (draft.baseUrl ?? storedCfg.baseUrl)
			.trim()
			.replace(/\/+$/, "");
		if (!apiKey) return;
		const toSave: TranslateProviderConfig = { ...storedCfg, apiKey, baseUrl };
		const masked = isSecretMask(apiKey) ? apiKey : maskSecret(apiKey);
		const nextTranslate = {
			...tr,
			provider: pid,
			providerConfigs: {
				...tr.providerConfigs,
				[pid]: { ...toSave, apiKey: masked },
			},
		};
		setProbe("probing");
		try {
			await saveSettingsAsync({
				...settings,
				translate: {
					...nextTranslate,
					providerConfigs: { ...tr.providerConfigs, [pid]: toSave },
				},
			});
		} catch (error) {
			setProbe("fail");
			notifyError(errorText(error));
			return;
		}
		setDraft({ apiKey: masked });
		patch({ translate: nextTranslate });
		try {
			const ok = await probeCommercialMtProvider(pid, { config: toSave });
			setProbe(ok ? "ok" : "fail");
		} catch {
			setProbe("fail");
		}
	};

	return (
		<Dialog open={configureOpen} onOpenChange={setConfigureOpen}>
			<div className="space-y-3">
				<div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2">
					<ChoiceCard
						icon={<Sparkles className="size-5 text-muted-foreground" />}
						title={t("translate.useDefault")}
						description={t("translate.useDefaultDesc")}
						recommended
						recommendedLabel={t("recommended")}
						selected={tr.provider === DEFAULT_TRANSLATE_SETTINGS.provider}
						onClick={chooseSystemDefault}
					/>
					<DialogTrigger asChild>
						<ChoiceCard
							icon={<KeyRound className="size-5 text-muted-foreground" />}
							title={t("translate.configureOwn")}
							description={t("translate.configureOwnDesc")}
							selected={isCommercial}
							onClick={enterConfigure}
						/>
					</DialogTrigger>
				</div>
				<p className="text-muted-foreground text-xs">
					{t("translate.settingsHint")}
				</p>
			</div>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("translate.configureOwn")}</DialogTitle>
					<DialogDescription>
						{t("translate.configureOwnDesc")}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<Select value={providerId} onValueChange={onProviderChange}>
							<SelectTrigger
								size="sm"
								className="w-full max-w-[180px]"
								aria-label={t("settings:translate.provider.label")}
								disabled={probe === "probing"}
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent className="max-h-72">
								{COMMERCIAL_MT_PROVIDER_IDS.map((id) => (
									<SelectItem key={id} value={id}>
										{t(
											`settings:translate.provider.${id}` as "settings:translate.provider.deepl",
										)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="shrink-0"
									aria-label={t("translate.openDocs")}
									title={t("translate.openDocs")}
									onClick={() =>
										openExternalUrl(COMMERCIAL_MT_DOCS_URLS[providerId])
									}
								>
									<ExternalLink className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								{t(
									`settings:translate.providerDesc.${providerId}` as "settings:translate.providerDesc.deepl",
								)}
							</TooltipContent>
						</Tooltip>
						<div className="ml-auto flex items-center gap-2">
							<ProbeDot
								status={probe}
								label={t(PROBE_LABEL_KEYS[probe])}
								title={t(PROBE_LABEL_KEYS[probe])}
							/>
							<Button
								type="button"
								size="sm"
								disabled={probe === "probing" || !displayKey.trim()}
								onClick={() => void confirmCommercial()}
							>
								{probe === "probing" ? (
									<LoaderCircle
										data-icon="inline-start"
										className="animate-spin"
									/>
								) : (
									<RefreshCw data-icon="inline-start" />
								)}
								{t("translate.test")}
							</Button>
						</div>
					</div>

					<Input
						value={displayKey}
						disabled={probe === "probing"}
						aria-label={t("translate.apiKeyPlaceholder")}
						placeholder={t("translate.apiKeyPlaceholder")}
						onChange={(e) =>
							setDraft((d) => ({ ...d, apiKey: e.target.value }))
						}
						className="h-8"
					/>

					<Input
						value={displayBaseUrl}
						disabled={probe === "probing"}
						aria-label={t("translate.endpointPlaceholder")}
						placeholder={
							COMMERCIAL_MT_DEFAULT_BASE_URLS[providerId] ??
							t("translate.endpointPlaceholder")
						}
						onChange={(e) =>
							setDraft((d) => ({ ...d, baseUrl: e.target.value }))
						}
						className="h-8 font-mono text-xs"
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
