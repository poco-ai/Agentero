import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type InstitutionProxyPresetOption,
	InstitutionProxyRow,
	NetworkProxyRow,
} from "@/components/settings/agent-common-rows";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import type { SettingsHostContext } from "@/components/settings/types";
import { Button } from "@/components/ui/button";
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
import { callApi, callResult } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import {
	PAPER_TREE_LABEL_MODES,
	PAPER_TREE_SORT_MODES,
	type PaperTreeLabelMode,
	type PaperTreeSortMode,
} from "@/lib/paper";
import {
	type AppSettings,
	AUTO_UPDATE_INTERNAL_LINKS,
	type AutoUpdateInternalLinks,
	PAPER_NOTE_MODES,
	type PaperNoteMode,
	PDF_SCROLL_STRATEGIES,
	PDF_SPREAD_MODES,
	type PdfScrollStrategy,
	type PdfSpreadMode,
	saveSettingsAsync,
} from "@/lib/settings";
import {
	DEFAULT_NETWORK_PROXY_URL,
	INSTITUTION_PROXY_PRESETS,
} from "@/lib/settings/defaults";
import type { ProbeStatus } from "@/lib/ui/probe-status";
import { notesTemplateSeed } from "@/lib/vault/note-template";
import { ConnectorSettingsBlock } from "./general/connector-settings-block";
import { EasyScholarSettingsBlock } from "./general/easy-scholar-settings-block";
import { FinderIntegrationRow } from "./general/finder-integration-row";
import { McpSettingsBlock } from "./general/mcp-settings-block";
import { PrivacySettingsBlock } from "./general/privacy-settings-block";
import { TerminalAppRow } from "./general/terminal-app-row";

export function GeneralPane({
	settings,
	patch,
	hostContext,
	vaultPath = null,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	hostContext: SettingsHostContext;
	vaultPath?: string | null;
}) {
	const { t } = useTranslation("settings");
	const [proxyUrlDraft, setProxyUrlDraft] = useState(settings.networkProxyUrl);
	const [easyScholarKeyDraft, setEasyScholarKeyDraft] = useState(
		settings.easyScholarKey,
	);
	// OS system proxy detected by the Host (Windows "Internet Settings"); used
	// automatically while the app proxy is off — surface it for transparency.
	const [systemProxy, setSystemProxy] = useState<string | null>(null);
	const [institutionProxyPrefixDraft, setInstitutionProxyPrefixDraft] =
		useState(settings.institutionProxyPrefix);
	const [institutionProxyCookieDraft, setInstitutionProxyCookieDraft] =
		useState(settings.institutionProxyCookie);
	const [institutionProxyTesting, setInstitutionProxyTesting] = useState(false);
	const [institutionProxyResult, setInstitutionProxyResult] = useState<
		{ status: "ok" | "fail"; message: string } | undefined
	>(undefined);
	const commitInstitutionProxy = useCallback(() => {
		patch({
			institutionProxyPrefix: institutionProxyPrefixDraft.trim(),
			institutionProxyCookie: institutionProxyCookieDraft.trim(),
		});
	}, [institutionProxyPrefixDraft, institutionProxyCookieDraft, patch]);
	const testInstitutionProxy = useCallback(async () => {
		setInstitutionProxyTesting(true);
		setInstitutionProxyResult(undefined);
		try {
			const result = await commands.institutionProxyProbe();
			setInstitutionProxyResult(
				result.ok
					? { status: "ok", message: result.data ?? "" }
					: { status: "fail", message: result.error?.message ?? "failed" },
			);
			if (result.error?.code === "institution_proxy_auth_required") {
				notifyError(t("general.institutionProxy.cookieExpired"));
			}
		} catch (error) {
			setInstitutionProxyResult({
				status: "fail",
				message: error instanceof Error ? error.message : "failed",
			});
		} finally {
			setInstitutionProxyTesting(false);
		}
	}, [t]);
	const openInstitutionLogin = useCallback(async () => {
		commitInstitutionProxy();
		try {
			const captured = await callResult(() =>
				commands.institutionProxyLoginOpen(institutionProxyPrefixDraft),
			);
			if (captured) void testInstitutionProxy();
		} catch (error) {
			notifyError(t("general.institutionProxy.loginFailed"), {
				description: errorText(error),
			});
		}
	}, [
		commitInstitutionProxy,
		institutionProxyPrefixDraft,
		t,
		testInstitutionProxy,
	]);
	const institutionProxyPresets = useMemo(
		() =>
			INSTITUTION_PROXY_PRESETS.map((preset) => ({
				...preset,
				label: t(`general.institutionProxy.presets.${preset.id}`),
			})),
		[t],
	);
	const selectInstitutionProxyPreset = useCallback(
		(preset: InstitutionProxyPresetOption) => {
			setInstitutionProxyPrefixDraft(preset.prefix);
			patch({
				institutionProxyPrefix: preset.prefix,
				institutionProxyType: preset.kind,
			});
		},
		[patch],
	);
	const institutionProxyProbeStatus: ProbeStatus = institutionProxyTesting
		? "probing"
		: (institutionProxyResult?.status ?? "idle");
	const institutionProxyProbeLabel = t(
		institutionProxyProbeStatus === "probing"
			? "general.institutionProxy.probeProbing"
			: institutionProxyProbeStatus === "ok"
				? "general.institutionProxy.probeOk"
				: institutionProxyProbeStatus === "fail"
					? "general.institutionProxy.probeFail"
					: "general.institutionProxy.probeIdle",
	);
	const [seedingTemplate, setSeedingTemplate] = useState(false);

	// Custom note mode seeds `.agentero/templates/NOTES.md` in the active vault;
	// remote vaults have no local template file to create.
	const canSeedTemplate = Boolean(vaultPath) && hostContext.kind === "local";

	const seedTemplate = async () => {
		if (!vaultPath || !canSeedTemplate) return;
		setSeedingTemplate(true);
		try {
			const res = await notesTemplateSeed(vaultPath);
			notifySuccess(
				t(
					res.created
						? "general.paperNoteMode.seedCreated"
						: "general.paperNoteMode.seedExists",
				),
			);
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setSeedingTemplate(false);
		}
	};

	useEffect(() => {
		setProxyUrlDraft(settings.networkProxyUrl);
		setInstitutionProxyPrefixDraft(settings.institutionProxyPrefix);
		setInstitutionProxyCookieDraft(settings.institutionProxyCookie);
	}, [
		settings.networkProxyUrl,
		settings.institutionProxyPrefix,
		settings.institutionProxyCookie,
	]);

	useEffect(() => {
		setEasyScholarKeyDraft(settings.easyScholarKey);
	}, [settings.easyScholarKey]);

	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		void callApi(() => commands.networkSystemProxy())
			.then((p) => {
				if (!cancelled) setSystemProxy(p ?? null);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<>
			<PageTitle title={t("general.title")} />
			{hostContext.kind === "remote" ? (
				<p className="mb-3 rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-muted-foreground text-xs leading-relaxed">
					{t("host.remoteContextHint", {
						host: hostContext.label,
						path: hostContext.remotePath || "—",
					})}
				</p>
			) : null}
			<SettingsSectionLabel>
				{t("general.sections.papers")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("general.paperTreeLabelMode.label")}>
					<Select
						value={settings.paperTreeLabelMode}
						onValueChange={(v) =>
							patch({ paperTreeLabelMode: v as PaperTreeLabelMode })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAPER_TREE_LABEL_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.paperTreeLabelMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.paperTreeSortMode.label")}>
					<Select
						value={settings.paperTreeSortMode}
						onValueChange={(v) =>
							patch({ paperTreeSortMode: v as PaperTreeSortMode })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAPER_TREE_SORT_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.paperTreeSortMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.paperNoteMode.label")}>
					<Select
						value={settings.paperNoteMode}
						onValueChange={(v) => patch({ paperNoteMode: v as PaperNoteMode })}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAPER_NOTE_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.paperNoteMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				{settings.paperNoteMode === "custom" ? (
					<SettingsRow
						label={
							<code className="font-mono text-muted-foreground text-xs">
								.agentero/templates/NOTES.md
							</code>
						}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={seedingTemplate || !canSeedTemplate}
									aria-label={t("general.paperNoteMode.seed")}
									onClick={() => void seedTemplate()}
								>
									{t("general.paperNoteMode.seed")}
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("general.paperNoteMode.seed")}</TooltipContent>
						</Tooltip>
					</SettingsRow>
				) : null}
				<SettingsRow
					label={t("general.autoOpenPaperNotes.label")}
					htmlFor="auto-open-paper-notes"
				>
					<Switch
						id="auto-open-paper-notes"
						checked={settings.autoOpenPaperNotes}
						onCheckedChange={(v) => patch({ autoOpenPaperNotes: v })}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("general.autoIngest.label")}
					htmlFor="auto-ingest"
				>
					<Switch
						id="auto-ingest"
						checked={settings.autoIngest}
						onCheckedChange={(v) => patch({ autoIngest: v })}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("general.replaceCurrentTabOnOpenPaper.label")}
					htmlFor="replace-current-tab-on-open-paper"
				>
					<Switch
						id="replace-current-tab-on-open-paper"
						checked={settings.replaceCurrentTabOnOpenPaper}
						onCheckedChange={(v) => patch({ replaceCurrentTabOnOpenPaper: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("general.autoUpdateInternalLinks.label")}>
					<Select
						value={settings.autoUpdateInternalLinks}
						onValueChange={(value) =>
							patch({
								autoUpdateInternalLinks: value as AutoUpdateInternalLinks,
							})
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{AUTO_UPDATE_INTERNAL_LINKS.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.autoUpdateInternalLinks.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.batchImportConcurrency.label")}>
					<Select
						value={String(settings.batchImportConcurrency)}
						onValueChange={(value) =>
							patch({ batchImportConcurrency: Number(value) })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Array.from({ length: 10 }, (_, index) => index + 1).map(
								(value) => (
									<SelectItem key={value} value={String(value)}>
										{t("general.batchImportConcurrency.value", { value })}
									</SelectItem>
								),
							)}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("general.sections.pdf")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("general.pdfScrollStrategy.label")}>
					<Select
						value={settings.pdfScrollStrategy}
						onValueChange={(value) =>
							patch({ pdfScrollStrategy: value as PdfScrollStrategy })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PDF_SCROLL_STRATEGIES.map((strategy) => (
								<SelectItem key={strategy} value={strategy}>
									{t(`general.pdfScrollStrategy.${strategy}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.pdfSpreadMode.label")}>
					<Select
						disabled={settings.pdfScrollStrategy === "paginated"}
						value={
							settings.pdfScrollStrategy === "paginated"
								? "none"
								: settings.pdfSpreadMode
						}
						onValueChange={(value) =>
							patch({ pdfSpreadMode: value as PdfSpreadMode })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PDF_SPREAD_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.pdfSpreadMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("general.sections.plaza")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("general.plaza.label")} htmlFor="plaza-enabled">
					<Switch
						id="plaza-enabled"
						checked={settings.plazaEnabled}
						onCheckedChange={(v) => patch({ plazaEnabled: v })}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("general.sections.system")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<TerminalAppRow
					value={settings.terminalApp}
					onChange={(terminalApp) => patch({ terminalApp })}
				/>
				<FinderIntegrationRow />
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("general.sections.network")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<NetworkProxyRow
					htmlFor="network-proxy-enabled"
					label={t("general.networkProxy.label")}
					description={
						!settings.networkProxyEnabled && systemProxy
							? t("general.networkProxy.systemDetected", {
									url: systemProxy,
								})
							: undefined
					}
					proxyUrl={proxyUrlDraft}
					proxyEnabled={settings.networkProxyEnabled}
					onProxyUrlChange={setProxyUrlDraft}
					onCommitProxyUrl={() =>
						patch({
							networkProxyUrl:
								proxyUrlDraft.trim() || DEFAULT_NETWORK_PROXY_URL,
						})
					}
					onToggleProxy={(networkProxyEnabled) =>
						patch({ networkProxyEnabled })
					}
				/>
			</SettingsGroup>
			<SettingsGroup>
				<SettingsRow
					label={t("general.institutionProxy.typeLabel")}
					htmlFor="institution-proxy-type"
				>
					<Select
						value={settings.institutionProxyType}
						onValueChange={(institutionProxyType) =>
							patch({ institutionProxyType })
						}
					>
						<SelectTrigger
							id="institution-proxy-type"
							size="sm"
							className="h-8 w-44 text-xs"
							disabled={!isTauri()}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="ezproxy" className="text-xs">
								{t("general.institutionProxy.typeEzproxy")}
							</SelectItem>
							<SelectItem value="wengine" className="text-xs">
								{t("general.institutionProxy.typeWengine")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<InstitutionProxyRow
					htmlFor="institution-proxy-prefix"
					label={t("general.institutionProxy.label")}
					prefix={institutionProxyPrefixDraft}
					cookie={institutionProxyCookieDraft}
					prefixPlaceholder={
						settings.institutionProxyType === "wengine"
							? "https://webvpn.example.edu"
							: "https://webvpn.example.edu/login?url="
					}
					cookiePlaceholder={t("general.institutionProxy.cookiePlaceholder")}
					cookieLabel={t("general.institutionProxy.cookieLabel")}
					loginLabel={t("general.institutionProxy.login")}
					testLabel={t("general.institutionProxy.test")}
					testingLabel={t("general.institutionProxy.testing")}
					presetsLabel={t("general.institutionProxy.presetsLabel")}
					presets={institutionProxyPresets}
					onPrefixChange={setInstitutionProxyPrefixDraft}
					onCookieChange={setInstitutionProxyCookieDraft}
					onPresetSelect={selectInstitutionProxyPreset}
					onCommit={commitInstitutionProxy}
					onTest={() => void testInstitutionProxy()}
					onLogin={() => void openInstitutionLogin()}
					testing={institutionProxyTesting}
					probeStatus={institutionProxyProbeStatus}
					probeLabel={institutionProxyProbeLabel}
					probeDetail={institutionProxyResult?.message}
				/>
			</SettingsGroup>
			<SettingsSectionLabel className="mt-4">
				{t("general.sections.integrations")}
			</SettingsSectionLabel>
			<ConnectorSettingsBlock settings={settings} patch={patch} />
			<EasyScholarSettingsBlock
				savedKey={settings.easyScholarKey}
				keyDraft={easyScholarKeyDraft}
				onKeyDraftChange={setEasyScholarKeyDraft}
				onCommitKey={async (value) => {
					const trimmed = value.trim();
					const next = await saveSettingsAsync({
						...settings,
						easyScholarKey: trimmed,
					});
					setEasyScholarKeyDraft(next.easyScholarKey);
				}}
			/>
			<SettingsSectionLabel>{t("general.sections.mcp")}</SettingsSectionLabel>
			<McpSettingsBlock
				settings={settings}
				patch={patch}
				disabled={hostContext.kind === "remote"}
			/>
			<PrivacySettingsBlock settings={settings} patch={patch} />
		</>
	);
}
