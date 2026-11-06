import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	PROVIDER_INPUT_CLASS,
	ProbeDot,
	ProviderCard,
	ProviderCardHeader,
	ProviderFieldRow,
} from "@/components/settings/provider-card";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import { saveSettingsAsync } from "@/lib/settings";
import {
	DECISION_PROVIDER_PRESETS,
	DEFAULT_DECISION_BASE_URL,
} from "@/lib/settings/defaults";
import {
	type AppSettings,
	DECISION_PROVIDER_IDS,
	type DecisionProviderId,
	type DecisionSettings,
} from "@/lib/settings/types";
import type { ProbeStatus } from "@/lib/ui/probe-status";

/** Provider-specific endpoint hint; the URL itself is not translated. */
function baseUrlPlaceholder(provider: DecisionProviderId): string {
	if (provider === "clef") {
		return "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/clef";
	}
	if (provider === "openai") {
		return DECISION_PROVIDER_PRESETS.openai.baseUrl;
	}
	return DEFAULT_DECISION_BASE_URL;
}

export function ExperimentalPane({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	const decision = settings.decision;
	const configured = decision.apiKey.trim().length > 0;
	const [probeStatus, setProbeStatus] = useState<ProbeStatus>("idle");
	const [draft, setDraft] = useState<Partial<DecisionSettings>>({});
	const [busy, setBusy] = useState(false);

	const provider = draft.provider ?? decision.provider;
	const preset = DECISION_PROVIDER_PRESETS[provider];

	const displayApiKey =
		draft.apiKey !== undefined
			? draft.apiKey
			: decision.apiKey
				? isSecretMask(decision.apiKey)
					? decision.apiKey
					: maskSecret(decision.apiKey)
				: "";

	const displayBaseUrl =
		draft.baseUrl !== undefined ? draft.baseUrl : decision.baseUrl;
	const displayModel = draft.model !== undefined ? draft.model : decision.model;

	const handleProviderChange = useCallback((value: string) => {
		const next = value as DecisionProviderId;
		const nextPreset = DECISION_PROVIDER_PRESETS[next];
		// Switching preset resets the endpoint/model to that provider's defaults;
		// the user can still edit them afterwards.
		setDraft((prev) => ({
			...prev,
			provider: next,
			baseUrl: nextPreset.baseUrl,
			model: nextPreset.model,
		}));
	}, []);

	const handleConfirm = useCallback(async () => {
		const nextSettings: AppSettings = {
			...settings,
			decision: {
				provider,
				apiKey: (draft.apiKey ?? decision.apiKey).trim(),
				baseUrl: (draft.baseUrl ?? decision.baseUrl).trim(),
				model: (draft.model ?? decision.model).trim(),
				smartHighlight: decision.smartHighlight,
			},
		};

		setBusy(true);
		try {
			const saved = await saveSettingsAsync(nextSettings);
			patch({ decision: saved.decision });
			setDraft({});

			if (!saved.decision.apiKey) {
				setProbeStatus("idle");
				return;
			}

			setProbeStatus("probing");
			try {
				await callApiResult(() => commands.jevProbeHealth());
				setProbeStatus("ok");
			} catch (err) {
				setProbeStatus("fail");
				notifyError(errorText(err));
			}
		} catch (err) {
			notifyError(errorText(err));
		} finally {
			setBusy(false);
		}
	}, [decision, draft, patch, provider, settings]);

	const statusLabel = configured
		? t(`experimental.decision.probeStatus.${probeStatus}`)
		: t("experimental.decision.probeStatus.unconfigured");

	return (
		<div className="space-y-6">
			<PageTitle title={t("experimental.title")} />

			<SettingsGroup>
				<SettingsRow
					label={t("experimental.decision.smartHighlight")}
					htmlFor="decision-smart-highlight"
				>
					<Switch
						id="decision-smart-highlight"
						checked={decision.smartHighlight}
						onCheckedChange={(v) =>
							patch({ decision: { ...decision, smartHighlight: v } })
						}
					/>
				</SettingsRow>
			</SettingsGroup>

			<ProviderCard>
				<ProviderCardHeader
					left={
						<>
							<Tooltip>
								<TooltipTrigger asChild>
									<ProbeDot
										status={probeStatus}
										configured={configured}
										label={statusLabel}
									/>
								</TooltipTrigger>
								<TooltipContent>{statusLabel}</TooltipContent>
							</Tooltip>
							<span className="truncate font-medium text-sm">
								{t("experimental.decision.section")}
							</span>
							{preset.keyUrl ? (
								<Button
									type="button"
									variant="link"
									size="xs"
									className="-ml-1.5 h-auto shrink-0 px-1.5 text-primary"
									onClick={() => openExternalUrl(preset.keyUrl)}
								>
									<ExternalLink data-icon="inline-start" className="size-3" />
									{t("experimental.decision.getKey")}
								</Button>
							) : null}
						</>
					}
					right={
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={busy}
							onClick={() => void handleConfirm()}
						>
							{busy ? (
								<Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
							) : null}
							{t("experimental.decision.test")}
						</Button>
					}
				/>

				<div className="grid gap-1.5">
					<ProviderFieldRow
						label={t("experimental.decision.provider.label")}
						htmlFor="decision-provider"
					>
						<Select value={provider} onValueChange={handleProviderChange}>
							<SelectTrigger
								id="decision-provider"
								size="sm"
								className="h-8 min-w-0 flex-1"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DECISION_PROVIDER_IDS.map((id) => (
									<SelectItem key={id} value={id}>
										{t(`experimental.decision.provider.${id}`)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</ProviderFieldRow>

					<ProviderFieldRow
						label={t("experimental.decision.apiKey.label")}
						htmlFor="decision-api-key"
					>
						<Input
							id="decision-api-key"
							type="password"
							value={displayApiKey}
							placeholder={t("experimental.decision.apiKey.placeholder")}
							className={PROVIDER_INPUT_CLASS}
							spellCheck={false}
							autoComplete="off"
							onChange={(e) =>
								setDraft((prev) => ({ ...prev, apiKey: e.target.value }))
							}
							onFocus={(e) => e.target.select()}
						/>
					</ProviderFieldRow>

					<ProviderFieldRow
						label={t("experimental.decision.baseUrl.label")}
						htmlFor="decision-base-url"
					>
						<Input
							id="decision-base-url"
							type="text"
							value={displayBaseUrl}
							placeholder={baseUrlPlaceholder(provider)}
							className={PROVIDER_INPUT_CLASS}
							spellCheck={false}
							autoComplete="off"
							onChange={(e) =>
								setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))
							}
						/>
					</ProviderFieldRow>

					<ProviderFieldRow
						label={t("experimental.decision.model.label")}
						htmlFor="decision-model"
					>
						<Input
							id="decision-model"
							type="text"
							value={displayModel}
							placeholder={t("experimental.decision.model.placeholder")}
							className={PROVIDER_INPUT_CLASS}
							spellCheck={false}
							autoComplete="off"
							onChange={(e) =>
								setDraft((prev) => ({ ...prev, model: e.target.value }))
							}
						/>
					</ProviderFieldRow>
				</div>
			</ProviderCard>
		</div>
	);
}
