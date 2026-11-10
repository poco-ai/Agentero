import {
	ArrowLeft,
	ExternalLink,
	KeyRound,
	LoaderCircle,
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
import { openExternalUrl } from "@/lib/core/open-external";
import {
	persistLayoutProviderConfig,
	probeLayoutProvider,
} from "@/lib/pdf/layout/provider-config";
import {
	isRemoteLayoutProvider,
	LAYOUT_PROVIDERS,
} from "@/lib/pdf/layout/providers";
import {
	DEFAULT_MINERU_LANGUAGE,
	LAYOUT_PROVIDER_DEFAULT_BASE_URLS,
	LAYOUT_PROVIDER_DOCS_URLS,
	type LayoutProviderId,
} from "@/lib/pdf/layout/settings";
import type { AppSettings } from "@/lib/settings";
import type { ProbeStatus } from "@/lib/ui/probe-status";

const REMOTE_PROVIDERS = Object.values(LAYOUT_PROVIDERS).filter(
	isRemoteLayoutProvider,
);

const PROBE_LABEL_KEYS = {
	ok: "layout.probeOk",
	fail: "layout.probeFail",
	probing: "layout.probeProbing",
	idle: "layout.probeIdle",
} as const satisfies Record<ProbeStatus, string>;

export function LayoutStep({
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
	const layout = settings.layout;
	const [mode, setMode] = useState<"choose" | "configure">("choose");
	const [providerId, setProviderId] = useState<LayoutProviderId>("paddle");
	const [draft, setDraft] = useState<{ apiKey?: string; baseUrl?: string }>({});
	const [probe, setProbe] = useState<ProbeStatus>("idle");

	const provider =
		REMOTE_PROVIDERS.find((p) => p.id === providerId) ?? REMOTE_PROVIDERS[0];
	const stored = layout.providerConfigs[provider.id];

	// Next is allowed once the user committed to the own-API flow ("use system
	// default" advances immediately from the chooser instead).
	useEffect(() => {
		onNextChange("layout", mode === "configure");
	}, [mode, onNextChange]);

	const useSystemDefault = () => {
		patch({ layout: { ...layout, backend: "local" } });
		onUseDefault();
	};

	const displayKey = draft.apiKey ?? stored?.apiKey ?? "";
	const displayBaseUrl = draft.baseUrl ?? stored?.baseUrl ?? "";

	const confirm = async () => {
		const apiKey = displayKey.trim();
		if (!apiKey) return;
		const baseUrl = provider.supportsBaseUrl ? displayBaseUrl.trim() : "";
		const { displayLayout } = await persistLayoutProviderConfig({
			settings,
			provider: provider.id,
			config: {
				apiKey,
				baseUrl,
				model: stored?.model ?? "",
				prompt: stored?.prompt ?? "",
				language: stored?.language ?? DEFAULT_MINERU_LANGUAGE,
				isOcr: stored?.isOcr ?? false,
				selfHosted: stored?.selfHosted ?? false,
			},
			backend: provider.id,
		});
		patch({ layout: displayLayout });
		setDraft({});
		setProbe("probing");
		const result = await probeLayoutProvider(provider.id, apiKey);
		setProbe(result.ok ? "ok" : "fail");
	};

	if (mode === "choose") {
		return (
			<div className="space-y-2">
				<div className="grid grid-cols-2 gap-3">
					<ChoiceCard
						icon={<KeyRound className="size-5 text-muted-foreground" />}
						title={t("layout.configureOwn")}
						description={t("layout.configureOwnDesc")}
						recommended
						recommendedLabel={t("recommended")}
						onClick={() => setMode("configure")}
					/>
					<ChoiceCard
						icon={<Sparkles className="size-5 text-muted-foreground" />}
						title={t("layout.useDefault")}
						description={t("layout.useDefaultDesc")}
						onClick={useSystemDefault}
					/>
				</div>
				<p className="text-muted-foreground text-xs">
					{t("layout.selfHostedHint")}
				</p>
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
				<Select
					value={provider.id}
					onValueChange={(value) => {
						setProviderId(value as LayoutProviderId);
						setDraft({});
						setProbe("idle");
					}}
				>
					<SelectTrigger
						size="sm"
						className="w-40 shrink-0"
						aria-label={t("settings:layout.backend.label")}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{REMOTE_PROVIDERS.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{t(
									`settings:layout.backend.${p.id}` as "settings:layout.backend.paddle",
								)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					className="shrink-0"
					onClick={() =>
						openExternalUrl(LAYOUT_PROVIDER_DOCS_URLS[provider.id])
					}
				>
					<ExternalLink data-icon="inline-start" className="size-4" />
					{t("layout.openDocsLabel")}
				</Button>
				<div className="ml-auto flex items-center gap-2">
					<ProbeDot
						status={probe}
						label={t(PROBE_LABEL_KEYS[probe])}
						title={t(PROBE_LABEL_KEYS[probe])}
					/>
					<Button
						type="button"
						size="sm"
						// Keep the button solid while probing; the disabled fade can
						// flash a grey block behind the spinner in WebKit.
						className={probe === "probing" ? "disabled:opacity-100" : undefined}
						disabled={probe === "probing" || !displayKey.trim()}
						onClick={() => void confirm()}
					>
						{probe === "probing" ? (
							<LoaderCircle data-icon="inline-start" className="animate-spin" />
						) : null}
						{t("layout.test")}
					</Button>
				</div>
			</div>
			<Input
				value={displayKey}
				placeholder={t(
					`settings:layout.providerConfig.apiKey.placeholder.${provider.id}` as "settings:layout.providerConfig.apiKey.placeholder.paddle",
				)}
				aria-label={t("settings:layout.providerConfig.apiKey.label")}
				onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
				className="h-8"
			/>
			{provider.supportsBaseUrl ? (
				<Input
					value={displayBaseUrl}
					placeholder={LAYOUT_PROVIDER_DEFAULT_BASE_URLS[provider.id]}
					aria-label={t("settings:layout.providerConfig.baseUrl.label")}
					onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
					className="h-8"
				/>
			) : null}
		</div>
	);
}
