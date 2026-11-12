import {
	ArrowLeft,
	ExternalLink,
	KeyRound,
	LoaderCircle,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChoiceCard } from "@/components/onboarding/choice-card";
import type { OnboardingStepId } from "@/components/onboarding/flow";
import { ProbeDot } from "@/components/settings/provider-card";
import { Button } from "@/components/ui/button";
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
import { openExternalUrl } from "@/lib/core/open-external";
import { isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import { cn } from "@/lib/core/utils";
import type {
	AppSettings,
	CommercialTranslateProviderId,
	TranslateProviderConfig,
	TranslateProviderId,
} from "@/lib/settings";
import { saveSettingsAsync } from "@/lib/settings";
import {
	COMMERCIAL_MT_DEFAULT_BASE_URLS,
	COMMERCIAL_MT_DOCS_URLS,
	COMMERCIAL_MT_PROVIDER_IDS,
	isCommercialTranslateProvider,
	isTranslateProviderId,
	probeCommercialMtProvider,
} from "@/lib/translate";
import {
	DEFAULT_TRANSLATE_SETTINGS,
	EMPTY_TRANSLATE_PROVIDER_CONFIG,
} from "@/lib/translate/defaults";
import type { ProbeStatus } from "@/lib/ui/probe-status";

// AI/ML API needs only a key (its model has a default), which is all this
// step asks for; the generic OpenAI-compatible card also needs a model.
const FIRST_COMMERCIAL_PROVIDER: CommercialTranslateProviderId = "aimlapi";

const PROBE_LABEL_KEYS = {
	ok: "translate.probeOk",
	fail: "translate.probeFail",
	probing: "translate.probeProbing",
	idle: "translate.probeIdle",
} as const satisfies Record<ProbeStatus, string>;

export function TranslateStep({
	settings,
	patch,
	onUseDefault,
	onNextChange,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	/** User picked "use system default" — wizard should advance. */
	onUseDefault: () => void;
	/** Report whether a choice has been made (gates Next). */
	onNextChange: (id: OnboardingStepId, allowed: boolean) => void;
}) {
	const { t } = useTranslation(["onboarding", "settings"]);
	const tr = settings.translate;
	const isCommercial = isCommercialTranslateProvider(tr.provider);
	const stored = isCommercial
		? tr.providerConfigs[tr.provider as CommercialTranslateProviderId]
		: undefined;
	const [mode, setMode] = useState<"choose" | "configure">("choose");
	const [draft, setDraft] = useState<{ apiKey?: string; baseUrl?: string }>({});
	const [probe, setProbe] = useState<ProbeStatus>("idle");

	// Free translation is preselected, so the step never blocks Next. The
	// commercial-API flow is opt-in and can still be left unfinished.
	useEffect(() => {
		onNextChange("translate", true);
	}, [onNextChange]);

	const enterConfigure = () => {
		setMode("configure");
		// Default the provider to a commercial engine so the API-key form is
		// immediately useful (user can still switch engines in the form).
		if (!isCommercial) {
			patch({ translate: { ...tr, provider: FIRST_COMMERCIAL_PROVIDER } });
		}
	};

	const chooseSystemDefault = () => {
		patch({
			translate: {
				...tr,
				provider: DEFAULT_TRANSLATE_SETTINGS.provider,
			},
		});
		onUseDefault();
	};

	const setDisplayMode = (displayMode: "overlay" | "dualPane") => {
		if (displayMode === tr.displayMode) return;
		patch({ translate: { ...tr, displayMode } });
	};

	const displayModeRow = (
		<div className="flex items-center justify-between gap-3">
			<span className="text-muted-foreground text-sm">
				{t("translate.displayMode.label")}
			</span>
			<div className="flex items-center rounded-lg border bg-muted p-0.5">
				{(["overlay", "dualPane"] as const).map((mode) => {
					const selected = tr.displayMode === mode;
					return (
						<button
							key={mode}
							type="button"
							aria-pressed={selected}
							onClick={() => setDisplayMode(mode)}
							className={cn(
								"rounded-md px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
								selected
									? "bg-background text-foreground shadow-raised"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{t(`translate.displayMode.${mode}`)}
						</button>
					);
				})}
			</div>
		</div>
	);

	const displayKey =
		draft.apiKey !== undefined ? draft.apiKey : (stored?.apiKey ?? "");
	const displayBaseUrl =
		draft.baseUrl !== undefined ? draft.baseUrl : (stored?.baseUrl ?? "");

	const onProviderChange = (value: string) => {
		if (!isTranslateProviderId(value)) return;
		patch({ translate: { ...tr, provider: value as TranslateProviderId } });
		setDraft({});
		setProbe("idle");
	};

	const confirmCommercial = async () => {
		if (!isCommercial) return;
		const pid = tr.provider as CommercialTranslateProviderId;
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
			providerConfigs: {
				...tr.providerConfigs,
				[pid]: { ...toSave, apiKey: masked },
			},
		};
		setDraft({ apiKey: masked });
		try {
			await saveSettingsAsync({ ...settings, translate: nextTranslate });
		} catch {
			// Still mask the UI below.
		}
		patch({ translate: nextTranslate });
		setProbe("probing");
		try {
			const ok = await probeCommercialMtProvider(pid, { config: toSave });
			setProbe(ok ? "ok" : "fail");
		} catch {
			setProbe("fail");
		}
	};

	if (mode === "choose") {
		return (
			<div className="space-y-4">
				<div className="grid grid-cols-2 gap-3">
					<ChoiceCard
						icon={<Sparkles className="size-5 text-muted-foreground" />}
						title={t("translate.useDefault")}
						description={t("translate.useDefaultDesc")}
						recommended
						recommendedLabel={t("recommended")}
						selected={!isCommercial}
						onClick={chooseSystemDefault}
					/>
					<ChoiceCard
						icon={<KeyRound className="size-5 text-muted-foreground" />}
						title={t("translate.configureOwn")}
						description={t("translate.configureOwnDesc")}
						onClick={enterConfigure}
					/>
				</div>
				{displayModeRow}
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className="-ml-1.5 shrink-0"
					aria-label={t("actions.back")}
					title={t("actions.back")}
					onClick={() => setMode("choose")}
				>
					<ArrowLeft className="size-4" />
				</Button>
				<Select value={tr.provider} onValueChange={onProviderChange}>
					<SelectTrigger size="sm" className="w-full max-w-[180px]">
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
								openExternalUrl(
									COMMERCIAL_MT_DOCS_URLS[
										tr.provider as CommercialTranslateProviderId
									],
								)
							}
						>
							<ExternalLink className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{t(
							`settings:translate.providerDesc.${tr.provider}` as "settings:translate.providerDesc.deepl",
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
						// Busy is not the same as invalid: keep the button solid while
						// probing so the disabled fade cannot flash a grey block behind
						// the spinner.
						className={probe === "probing" ? "disabled:opacity-100" : undefined}
						disabled={probe === "probing" || !displayKey.trim()}
						onClick={() => void confirmCommercial()}
					>
						{probe === "probing" ? (
							<LoaderCircle data-icon="inline-start" className="animate-spin" />
						) : (
							<RefreshCw data-icon="inline-start" />
						)}
						{t("translate.test")}
					</Button>
				</div>
			</div>

			<Input
				value={displayKey}
				placeholder={t("translate.apiKeyPlaceholder")}
				onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
				className="h-8"
			/>

			<Input
				value={displayBaseUrl}
				placeholder={
					COMMERCIAL_MT_DEFAULT_BASE_URLS[
						tr.provider as CommercialTranslateProviderId
					] ?? t("translate.endpointPlaceholder")
				}
				onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
				className="h-8 font-mono text-xs"
			/>

			{displayModeRow}
		</div>
	);
}
