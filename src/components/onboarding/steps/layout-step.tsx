import { ExternalLink, KeyRound, LoaderCircle, Sparkles } from "lucide-react";
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
	type LayoutBackend,
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
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation(["onboarding", "settings"]);
	const layout = settings.layout;
	const [configureOpen, setConfigureOpen] = useState(false);
	const [providerId, setProviderId] = useState<Exclude<LayoutBackend, "local">>(
		layout.backend === "local" ? "paddle" : layout.backend,
	);
	const [draft, setDraft] = useState<{ apiKey?: string; baseUrl?: string }>({});
	const [probe, setProbe] = useState<ProbeStatus>("idle");

	const provider =
		REMOTE_PROVIDERS.find((p) => p.id === providerId) ?? REMOTE_PROVIDERS[0];
	const stored = layout.providerConfigs[provider.id];

	const enterConfigure = () => {
		const id = layout.backend === "local" ? "paddle" : layout.backend;
		setProviderId(id);
		setDraft({});
		setProbe("idle");
		openExternalUrl(LAYOUT_PROVIDER_DOCS_URLS[id]);
	};

	const useSystemDefault = () => {
		patch({ layout: { ...layout, backend: "local" } });
	};

	const displayKey = draft.apiKey ?? stored?.apiKey ?? "";
	const displayBaseUrl = draft.baseUrl ?? stored?.baseUrl ?? "";

	const confirm = async () => {
		const apiKey = displayKey.trim();
		if (!apiKey) return;
		const baseUrl = provider.supportsBaseUrl ? displayBaseUrl.trim() : "";
		setProbe("probing");
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
		const ok = await probeLayoutProvider(provider.id, apiKey);
		setProbe(ok ? "ok" : "fail");
	};

	return (
		<Dialog open={configureOpen} onOpenChange={setConfigureOpen}>
			<div className="space-y-3">
				<div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2">
					<ChoiceCard
						icon={<Sparkles className="size-5 text-muted-foreground" />}
						title={t("layout.useDefault")}
						description={t("layout.useDefaultDesc")}
						recommended
						recommendedLabel={t("recommended")}
						selected={layout.backend === "local"}
						onClick={useSystemDefault}
					/>
					<DialogTrigger asChild>
						<ChoiceCard
							icon={<KeyRound className="size-5 text-muted-foreground" />}
							title={t("layout.configureOwn")}
							description={t("layout.configureOwnDesc")}
							selected={layout.backend !== "local"}
							onClick={enterConfigure}
						/>
					</DialogTrigger>
				</div>
				<p className="text-muted-foreground text-xs">
					{t("layout.settingsHint")}
				</p>
			</div>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("layout.configureOwn")}</DialogTitle>
					<DialogDescription>{t("layout.configureOwnDesc")}</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<Select
							value={provider.id}
							disabled={probe === "probing"}
							onValueChange={(value) => {
								if (value !== "paddle" && value !== "mineru") return;
								setProviderId(value);
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
								disabled={probe === "probing" || !displayKey.trim()}
								onClick={() => void confirm()}
							>
								{probe === "probing" ? (
									<LoaderCircle
										data-icon="inline-start"
										className="animate-spin"
									/>
								) : null}
								{t("layout.test")}
							</Button>
						</div>
					</div>
					<Input
						value={displayKey}
						disabled={probe === "probing"}
						placeholder={t(
							`settings:layout.providerConfig.apiKey.placeholder.${provider.id}` as "settings:layout.providerConfig.apiKey.placeholder.paddle",
						)}
						aria-label={t("settings:layout.providerConfig.apiKey.label")}
						onChange={(e) =>
							setDraft((d) => ({ ...d, apiKey: e.target.value }))
						}
						className="h-8"
					/>
					{provider.supportsBaseUrl ? (
						<Input
							value={displayBaseUrl}
							disabled={probe === "probing"}
							placeholder={LAYOUT_PROVIDER_DEFAULT_BASE_URLS[provider.id]}
							aria-label={t("settings:layout.providerConfig.baseUrl.label")}
							onChange={(e) =>
								setDraft((d) => ({ ...d, baseUrl: e.target.value }))
							}
							className="h-8"
						/>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
