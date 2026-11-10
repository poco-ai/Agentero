import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AgentCommonRows } from "@/components/settings/agent-common-rows";
import { AgentModelPicker } from "@/components/settings/agent-model-picker";
import { DesktopAppsSection } from "@/components/settings/desktop-apps-rows";
import {
	AgentCatalogRows,
	RemoteAgentCatalogRow,
} from "@/components/settings/panes/agent/agent-catalog-rows";
import { AgentCustomForm } from "@/components/settings/panes/agent/agent-custom-form";
import { AgentDefaultBlock } from "@/components/settings/panes/agent/agent-default-block";
import { AgentEmbeddingBlock } from "@/components/settings/panes/agent/agent-embedding-block";
import { AgentNodeNotice } from "@/components/settings/panes/agent/agent-node-notice";
import { AgentPersonalPromptBlock } from "@/components/settings/panes/agent/agent-personal-prompt-block";
import { AgentUserAgentBlock } from "@/components/settings/panes/agent/agent-user-agent-block";
import { useAgentCatalog } from "@/components/settings/panes/agent/use-agent-catalog";
import { useAgentRegistry } from "@/components/settings/panes/agent/use-agent-registry";
import { useAgentUninstall } from "@/components/settings/panes/agent/use-agent-uninstall";
import { ZhihuAgentRow } from "@/components/settings/panes/agent/zhihu-agent-row";
import { catalogProbeKey } from "@/components/settings/panes/agent-catalog";
import { AgentUninstallDialog } from "@/components/settings/panes/agent-uninstall-dialog";
import {
	PageTitle,
	SettingsGroup,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import type { SettingsHostContext } from "@/components/settings/types";
import { Button } from "@/components/ui/button";
import { useAgentToolLifecycle } from "@/hooks/use-agent-tool-lifecycle";
import {
	type AgentTemplate,
	type CatalogEntry,
	openAgentCliTerminal,
	upsertAgent,
} from "@/lib/agent";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import type { AppSettings } from "@/lib/settings";
import { remoteAgentOpenInstallTerminal } from "@/lib/vault/remote/remote-vault";

export function AgentPane({
	settings,
	patch,
	onOpenDiagnostics,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	/** Switch the settings window to Environment diagnostics. */
	onOpenDiagnostics: () => void;
}) {
	const { t } = useTranslation(["settings", "agent", "common"]);
	const {
		catalog,
		loading,
		setLoading,
		probingKeys,
		clearAllProbingKeys,
		scanOnce,
		probeInstalled,
		refreshVersions,
		rescanAndProbe,
		openLoginTerminal,
		patchUserAgent,
	} = useAgentCatalog({ transport: "local" });

	// Agent/model seats (PDF Ask + 精读 paper-reader) share one listAgents registry
	const { registry: seatRegistry, refresh: refreshSeatRegistry } =
		useAgentRegistry(catalog);
	const pdfAsk = settings.pdfAsk;
	const pdfAskValue = useMemo(
		() => ({ agentId: pdfAsk.agentId, modelId: pdfAsk.modelId }),
		[pdfAsk.agentId, pdfAsk.modelId],
	);
	const onPdfAskChange = useCallback(
		(next: { agentId: string; modelId: string }) => {
			patch({ pdfAsk: { ...settings.pdfAsk, ...next } });
		},
		[patch, settings.pdfAsk],
	);
	const paperReader = settings.paperReader;
	const paperReaderValue = useMemo(
		() => ({ agentId: paperReader.agentId, modelId: paperReader.modelId }),
		[paperReader.agentId, paperReader.modelId],
	);
	const onPaperReaderChange = useCallback(
		(next: { agentId: string; modelId: string }) => {
			patch({ paperReader: { ...settings.paperReader, ...next } });
		},
		[patch, settings.paperReader],
	);

	/** Silent install/update/uninstall: Host scopes Agent vs ACP from PATH (no free-form shell). */
	const lifecycle = useAgentToolLifecycle({
		scanOnce,
		probeInstalled,
		refreshVersions,
	});
	const { runToolLifecycle: onToolLifecycle } = lifecycle;

	const {
		uninstallTarget,
		setUninstallTarget,
		uninstallBusy,
		openUninstallDialog,
		onUninstallConfirm,
	} = useAgentUninstall({ scanOnce, onToolLifecycle });

	const handleAddCustom = useCallback(
		async (draft: {
			id?: string;
			name: string;
			command: string;
			args: string;
		}): Promise<boolean> => {
			if (!isTauri()) return false;
			setLoading(true);
			try {
				const args = draft.args.trim().split(/\s+/).filter(Boolean);
				await upsertAgent({
					id: draft.id,
					name: draft.name.trim() || draft.command,
					template: "custom" as AgentTemplate,
					command: draft.command.trim(),
					args,
					setDefault: !draft.id,
				});
				const scan = await scanOnce();
				if (scan) {
					await probeInstalled(scan, true);
					await scanOnce();
				}
				return true;
			} catch (e) {
				notifyError(errorText(e));
				return false;
			} finally {
				setLoading(false);
				clearAllProbingKeys();
			}
		},
		[scanOnce, probeInstalled, setLoading, clearAllProbingKeys],
	);

	const busy = loading;

	const onOpenCli = useCallback(
		(templateId: string) => {
			if (!isTauri()) {
				notifyError(t("agent.desktopOnly"));
				return;
			}
			void openAgentCliTerminal(templateId).catch((e) =>
				notifyError(errorText(e)),
			);
		},
		[t],
	);

	return (
		<>
			<PageTitle title={t("agent.title")} />
			<AgentNodeNotice
				nodeMissing={lifecycle.hostNode.nodeMissing}
				npmMissing={lifecycle.hostNode.npmMissing}
				nodeUnusable={lifecycle.hostNode.nodeUnusable}
				npmUnusable={lifecycle.hostNode.npmUnusable}
				installing={lifecycle.hostNode.installing}
				onInstall={() => void lifecycle.hostNode.installNode()}
				onOpenDiagnostics={onOpenDiagnostics}
			/>
			<SettingsGroup>
				<AgentCommonRows settings={settings} patch={patch} />
			</SettingsGroup>

			<AgentDefaultBlock
				catalog={catalog}
				scanOnce={scanOnce}
				onDefaultApplied={() => void refreshSeatRegistry()}
			/>

			{!isTauri() ? (
				<p className="mb-3 text-muted-foreground text-xs">
					{t("agent.desktopHint")}
				</p>
			) : null}

			{/* Common agents first — install/update before prefs that pick among them. */}
			<div className="mb-2 flex items-center justify-between gap-2">
				<SettingsSectionLabel className="mb-0 px-0">
					{t("agent.commonAgents")}
				</SettingsSectionLabel>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("agent.probe")}
					title={t("agent.probe")}
					disabled={busy || !isTauri()}
					onClick={() => {
						// Re-probe the host tools too: Node.js may have been installed
						// outside the app since the pane mounted.
						void lifecycle.hostNode.refresh();
						void rescanAndProbe(true);
					}}
				>
					{/* Loader2 while busy — avoid RefreshCw+spin (looks like two arrows, one stuck). */}
					{busy ? (
						<Loader2 className="size-3.5 animate-spin" aria-hidden />
					) : (
						<RefreshCw className="size-3.5" aria-hidden />
					)}
				</Button>
			</div>

			<SettingsGroup>
				<AgentCatalogRows
					catalog={catalog}
					loading={loading}
					probingKeys={probingKeys}
					lifecycle={lifecycle}
					openUninstallDialog={openUninstallDialog}
					onLogin={openLoginTerminal}
					onOpenCli={onOpenCli}
					onEditCustom={handleAddCustom}
				/>
				<ZhihuAgentRow
					savedSecret={settings.zhihuAccessSecret}
					onCommit={(value) => patch({ zhihuAccessSecret: value })}
				/>
				<AgentCustomForm busy={loading} onSubmit={handleAddCustom} />
			</SettingsGroup>
			<p className="mt-2 mb-3 px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("agent.commonAgentsHint")}
			</p>

			<DesktopAppsSection />

			<AgentPersonalPromptBlock settings={settings} patch={patch} />

			<SettingsSectionLabel className="mt-4">
				{t("agent.pdfAsk.section")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<AgentModelPicker
					value={pdfAskValue}
					onChange={onPdfAskChange}
					registry={seatRegistry}
					agentLabel={t("agent.pdfAsk.agentId.label")}
					modelLabel={t("agent.pdfAsk.modelId.label")}
					followDefaultLabel={t("agent.pdfAsk.agentId.followDefault")}
					followDefaultNamedLabel={(name) =>
						t("agent.pdfAsk.agentId.followDefaultNamed", { name })
					}
					followModelLabel={t("agent.pdfAsk.modelId.followAgent")}
					emptyState={
						<p className="px-3 py-2 text-muted-foreground text-xs">
							{t("agent.pdfAsk.agentId.empty")}
						</p>
					}
				/>
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				{t("agent.paperReader.section")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<AgentModelPicker
					value={paperReaderValue}
					onChange={onPaperReaderChange}
					registry={seatRegistry}
					agentLabel={t("agent.paperReader.agentId.label")}
					modelLabel={t("agent.paperReader.modelId.label")}
					followDefaultLabel={t("agent.pdfAsk.agentId.followDefault")}
					followDefaultNamedLabel={(name) =>
						t("agent.pdfAsk.agentId.followDefaultNamed", { name })
					}
					followModelLabel={t("agent.pdfAsk.modelId.followAgent")}
					emptyState={
						<p className="px-3 py-2 text-muted-foreground text-xs">
							{t("agent.pdfAsk.agentId.empty")}
						</p>
					}
				/>
			</SettingsGroup>

			<AgentUserAgentBlock
				initialUserAgent={catalog?.userAgent ?? ""}
				initialProviderIds={catalog?.userAgentProviderIds ?? ""}
				onCommitted={patchUserAgent}
			/>

			<AgentEmbeddingBlock settings={settings} patch={patch} />

			<AgentUninstallDialog
				open={uninstallTarget !== null}
				name={
					uninstallTarget?.kind === "custom"
						? uninstallTarget.name
						: (uninstallTarget?.entry.name ?? "")
				}
				template={
					uninstallTarget?.kind === "custom"
						? uninstallTarget.template
						: uninstallTarget?.entry.templateId
				}
				info={uninstallTarget?.kind === "catalog" ? uninstallTarget.info : null}
				busy={uninstallBusy}
				onConfirm={(scope) => void onUninstallConfirm(scope)}
				onCancel={() => setUninstallTarget(null)}
			/>
		</>
	);
}

/**
 * Agent settings when the active vault is remote: discover + ACP probe run on the
 * SSH host (not this machine). App-level prefs (permission, language) still apply.
 */
export function RemoteAgentPane({
	settings,
	patch,
	hostContext,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	hostContext: Extract<SettingsHostContext, { kind: "remote" }>;
}) {
	const { t } = useTranslation(["settings", "agent", "common"]);
	const sessionId = hostContext.sessionId;
	// Scan + ACP probe run on the SSH host via the remote transport; the hook
	// soft-probes when the session changes.
	const { catalog, loading, probingKeys, rescanAndProbe } = useAgentCatalog({
		transport: { remote: { sessionId } },
	});
	const entries = catalog?.entries ?? [];
	// A scan or any in-flight probe marks not-probed rows as "probing".
	const batchActive = loading || probingKeys.size > 0;

	const onInstallAdapter = async (entry: CatalogEntry) => {
		if (!isTauri()) return;
		try {
			await remoteAgentOpenInstallTerminal(sessionId, entry.templateId);
		} catch (e) {
			notifyError(errorText(e));
		}
	};

	const busy = loading;

	return (
		<>
			<PageTitle title={t("agent.title")} />
			<p className="mb-3 rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-muted-foreground text-xs leading-relaxed">
				{t("agent.remote.banner", {
					host: hostContext.label,
					path: hostContext.remotePath || "—",
				})}
			</p>

			<SettingsGroup>
				<AgentCommonRows settings={settings} patch={patch} idSuffix="-r" />
			</SettingsGroup>

			{!isTauri() ? (
				<p className="mb-3 text-muted-foreground text-xs">
					{t("agent.desktopHint")}
				</p>
			) : null}

			<div className="mb-2 flex items-center justify-between gap-2">
				<SettingsSectionLabel className="mb-0 px-0">
					{t("agent.remote.commonAgents")}
				</SettingsSectionLabel>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("agent.probe")}
					title={t("agent.remote.probeTitle")}
					disabled={busy || !isTauri()}
					onClick={() => void rescanAndProbe(true)}
				>
					{busy ? (
						<Loader2 className="size-3.5 animate-spin" aria-hidden />
					) : (
						<RefreshCw className="size-3.5" aria-hidden />
					)}
				</Button>
			</div>

			<SettingsGroup>
				{entries.length === 0 && busy ? (
					<div className="flex items-center gap-2 px-3.5 py-4 text-muted-foreground text-xs">
						<Loader2 className="size-3.5 animate-spin" aria-hidden />
						{t("agent.scanning")}
					</div>
				) : null}
				{entries.length === 0 && !busy ? (
					<p className="px-3.5 py-3 text-muted-foreground text-xs">
						{t("agent.remote.empty")}
					</p>
				) : null}
				{entries.map((entry) => (
					<RemoteAgentCatalogRow
						key={entry.templateId}
						entry={entry}
						hostLabel={hostContext.label}
						probing={probingKeys.has(catalogProbeKey(entry.templateId))}
						batchActive={batchActive}
						busy={busy}
						onInstall={(e) => void onInstallAdapter(e)}
					/>
				))}
			</SettingsGroup>
			<p className="mt-2 mb-3 px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("agent.remote.hint")}
			</p>
		</>
	);
}
