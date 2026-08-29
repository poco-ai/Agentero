import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AgentCommonRows } from "@/components/settings/agent-common-rows";
import { AgentModelPicker } from "@/components/settings/agent-model-picker";
import {
	AgentCatalogRows,
	RemoteAgentCatalogRow,
} from "@/components/settings/panes/agent/agent-catalog-rows";
import { AgentCustomForm } from "@/components/settings/panes/agent/agent-custom-form";
import { AgentDefaultBlock } from "@/components/settings/panes/agent/agent-default-block";
import { AgentEmbeddingBlock } from "@/components/settings/panes/agent/agent-embedding-block";
import { AgentPersonalPromptBlock } from "@/components/settings/panes/agent/agent-personal-prompt-block";
import { AgentUserAgentBlock } from "@/components/settings/panes/agent/agent-user-agent-block";
import { useAgentCatalog } from "@/components/settings/panes/agent/use-agent-catalog";
import { useAgentRegistry } from "@/components/settings/panes/agent/use-agent-registry";
import { useAgentUninstall } from "@/components/settings/panes/agent/use-agent-uninstall";
import { catalogProbeKey } from "@/components/settings/panes/agent-catalog";
import { AgentUninstallDialog } from "@/components/settings/panes/agent-uninstall-dialog";
import {
	PageTitle,
	SettingsGroup,
} from "@/components/settings/settings-layout";
import type { SettingsHostContext } from "@/components/settings/types";
import { Button } from "@/components/ui/button";
import { useAgentToolLifecycle } from "@/hooks/use-agent-tool-lifecycle";
import {
	type AgentTemplate,
	type CatalogEntry,
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
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
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
		rescanAndProbe,
		patchUserAgent,
	} = useAgentCatalog({ transport: "local" });

	// PDF Ask agent/model (same listAgents registry as Translate → Agent)
	const { registry: pdfAskRegistry, refresh: refreshPdfAskRegistry } =
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

	/** Silent install/update/uninstall: Host scopes Agent vs ACP from PATH (no free-form shell). */
	const lifecycle = useAgentToolLifecycle({ scanOnce, probeInstalled });
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
			name: string;
			command: string;
			args: string;
		}): Promise<boolean> => {
			if (!isTauri()) return false;
			setLoading(true);
			try {
				const args = draft.args.trim().split(/\s+/).filter(Boolean);
				await upsertAgent({
					name: draft.name.trim() || draft.command,
					template: "custom" as AgentTemplate,
					command: draft.command.trim(),
					args,
					setDefault: true,
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

	return (
		<>
			<PageTitle title={t("agent.title")} />
			<SettingsGroup>
				<AgentCommonRows settings={settings} patch={patch} />
			</SettingsGroup>

			<AgentDefaultBlock
				catalog={catalog}
				scanOnce={scanOnce}
				onDefaultApplied={() => void refreshPdfAskRegistry()}
			/>

			{!isTauri() ? (
				<p className="mb-3 text-muted-foreground text-xs">
					{t("agent.desktopHint")}
				</p>
			) : null}

			{/* Common agents first — install/update before prefs that pick among them. */}
			<div className="mb-2 flex items-center justify-between gap-2">
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					{t("agent.commonAgents")}
				</p>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("agent.probe")}
					title={t("agent.probe")}
					disabled={busy || !isTauri()}
					onClick={() => void rescanAndProbe(true)}
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
				/>
				<AgentCustomForm busy={loading} onSubmit={handleAddCustom} />
			</SettingsGroup>
			<p className="mt-2 mb-3 px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("agent.commonAgentsHint")}
			</p>

			<AgentPersonalPromptBlock settings={settings} patch={patch} />

			<p className="mb-1.5 mt-4 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{t("agent.pdfAsk.section")}
			</p>
			<SettingsGroup>
				<AgentModelPicker
					value={pdfAskValue}
					onChange={onPdfAskChange}
					registry={pdfAskRegistry}
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
				onConfirm={() => void onUninstallConfirm()}
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
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					{t("agent.remote.commonAgents")}
				</p>
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
