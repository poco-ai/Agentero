import { Copy, ExternalLink, LoaderCircle, Power } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	GitHubMirrorRow,
	NetworkProxyRow,
} from "@/components/settings/agent-common-rows";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { StatusDot } from "@/components/settings/status-dot";
import type { SettingsHostContext } from "@/components/settings/types";
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
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { clearUsage } from "@/lib/activity";
import { commands, events } from "@/lib/core/bindings";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isTauri } from "@/lib/core/tauri";
import {
	type EasyScholarProbeStatus,
	hasEasyScholarKey,
	isEasyScholarKeyMask,
	maskEasyScholarKey,
	probeEasyScholarKey,
} from "@/lib/easyscholar";
import {
	type McpStatus,
	mcpGetStatus,
	mcpSetEnabled,
	mcpSetPort,
} from "@/lib/mcp/status";
import {
	type McpTunnelPhase,
	type McpTunnelStatus,
	mcpTunnelStart,
	mcpTunnelStatus,
	mcpTunnelStop,
} from "@/lib/mcp/tunnel";
import {
	PAPER_TREE_LABEL_MODES,
	PAPER_TREE_SORT_MODES,
	type PaperTreeLabelMode,
	type PaperTreeSortMode,
} from "@/lib/paper";
import {
	type ConnectorStatus,
	connectorGetStatus,
	connectorSetEnabled,
	connectorSetPort,
} from "@/lib/paper/import/connector";
import {
	type AppSettings,
	AUTO_UPDATE_INTERNAL_LINKS,
	type AutoUpdateInternalLinks,
	PAPER_NOTE_MODES,
	type PaperNoteMode,
	saveSettingsAsync,
} from "@/lib/settings";
import { DEFAULT_NETWORK_PROXY_URL } from "@/lib/settings/defaults";
import { notesTemplateSeed } from "@/lib/vault/note-template";

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
	}, [settings.networkProxyUrl]);

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
				<SettingsRow label={t("general.plaza.label")} htmlFor="plaza-enabled">
					<Switch
						id="plaza-enabled"
						checked={settings.plazaEnabled}
						onCheckedChange={(v) => patch({ plazaEnabled: v })}
					/>
				</SettingsRow>
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
				<GitHubMirrorRow
					htmlFor="github-mirror-enabled"
					label={t("general.githubMirror.label")}
					description={t("general.githubMirror.description")}
					value={settings.githubMirrorBaseUrl}
					enabled={settings.githubMirrorEnabled}
					onValueChange={(githubMirrorBaseUrl) =>
						patch({ githubMirrorBaseUrl })
					}
					onToggle={(githubMirrorEnabled) => patch({ githubMirrorEnabled })}
				/>
			</SettingsGroup>
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
			<ConnectorSettingsBlock settings={settings} patch={patch} />
			<div className="mt-4">
				<p className="mb-2 px-0.5 font-medium text-sm">
					{t("general.mcp.label")}
				</p>
				<McpSettingsBlock
					settings={settings}
					patch={patch}
					disabled={hostContext.kind === "remote"}
				/>
			</div>
			<ExportSettingsBlock settings={settings} patch={patch} />
			<PrivacySettingsBlock settings={settings} patch={patch} />
		</>
	);
}

function EasyScholarSettingsBlock({
	savedKey,
	keyDraft,
	onKeyDraftChange,
	onCommitKey,
}: {
	savedKey: string;
	keyDraft: string;
	onKeyDraftChange: (value: string) => void;
	onCommitKey: (value: string) => Promise<void>;
}) {
	const { t } = useTranslation("settings");
	const [status, setStatus] = useState<EasyScholarProbeStatus>("idle");
	const abortRef = useRef<AbortController | null>(null);

	const runProbe = useCallback(async () => {
		if (!hasEasyScholarKey(savedKey)) {
			setStatus("idle");
			return;
		}
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setStatus("probing");
		const ok = await probeEasyScholarKey(ac.signal);
		if (ac.signal.aborted) return;
		setStatus(ok ? "ok" : "fail");
	}, [savedKey]);

	useEffect(() => {
		void runProbe();
		return () => {
			abortRef.current?.abort();
		};
	}, [runProbe]);

	const changed = useMemo(() => {
		const saved = savedKey.trim();
		const draft = keyDraft.trim();
		if (!saved && !draft) return false;
		if (!saved || !draft) return true;
		return draft !== saved;
	}, [savedKey, keyDraft]);

	const handleConfirm = async () => {
		await onCommitKey(keyDraft.trim());
	};

	const statusLabel = t(
		status === "idle"
			? "general.easyScholar.probeIdle"
			: status === "probing"
				? "general.easyScholar.probeProbing"
				: status === "ok"
					? "general.easyScholar.probeOk"
					: "general.easyScholar.probeFail",
	);

	return (
		<div className="mt-4">
			<p className="mb-2 px-0.5 font-medium text-sm">
				{t("general.easyScholar.section")}
			</p>
			<SettingsGroup>
				<SettingsRow
					label={
						<span className="inline-flex items-center gap-1.5">
							{t("general.easyScholar.keyLabel")}
							<StatusDot tone={probeTone(status)} label={statusLabel} />
						</span>
					}
					htmlFor="easy-scholar-key"
				>
					<div className="flex items-center gap-2">
						<Input
							id="easy-scholar-key"
							type="password"
							autoComplete="off"
							placeholder={t("general.easyScholar.placeholder")}
							className="h-8 w-64 max-w-[18rem] font-mono text-xs"
							value={keyDraft}
							onChange={(e) => {
								const next = e.currentTarget.value;
								const shownMask = hasEasyScholarKey(savedKey)
									? isEasyScholarKeyMask(savedKey)
										? savedKey
										: maskEasyScholarKey(savedKey)
									: null;
								if (
									shownMask != null &&
									(next === shownMask || next.startsWith(shownMask))
								) {
									onKeyDraftChange(next.slice(shownMask.length));
								} else {
									onKeyDraftChange(next);
								}
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									void handleConfirm();
								}
							}}
						/>
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={!changed || status === "probing"}
							onClick={() => void handleConfirm()}
						>
							{t("general.easyScholar.confirm")}
						</Button>
					</div>
				</SettingsRow>
			</SettingsGroup>
		</div>
	);
}

function probeTone(
	status: EasyScholarProbeStatus,
): "ok" | "idle" | "warn" | "err" {
	switch (status) {
		case "ok":
			return "ok";
		case "probing":
			return "warn";
		case "fail":
			return "err";
		default:
			return "idle";
	}
}

function PrivacySettingsBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<div className="mt-4">
			<p className="mb-2 px-0.5 font-medium text-sm">
				{t("general.privacy.section")}
			</p>
			<SettingsGroup>
				<SettingsRow
					label={t("general.privacy.telemetry.label")}
					htmlFor="telemetry-enabled"
				>
					<Switch
						id="telemetry-enabled"
						checked={settings.telemetryEnabled}
						onCheckedChange={(v) => patch({ telemetryEnabled: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("general.privacy.clearUsage.label")}>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							void clearUsage()
								.then(() => notifySuccess(t("general.privacy.clearUsage.done")))
								.catch((e) => notifyError(errorText(e)));
						}}
					>
						{t("general.privacy.clearUsage.action")}
					</Button>
				</SettingsRow>
			</SettingsGroup>
		</div>
	);
}

function ExportSettingsBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<div className="mt-4">
			<p className="mb-2 px-0.5 font-medium text-sm">
				{t("general.export.section")}
			</p>
			<SettingsGroup>
				<SettingsRow
					label={t("general.export.watermark.label")}
					htmlFor="export-watermark-enabled"
				>
					<Switch
						id="export-watermark-enabled"
						checked={settings.exportWatermarkEnabled}
						onCheckedChange={(v) => patch({ exportWatermarkEnabled: v })}
					/>
				</SettingsRow>
			</SettingsGroup>
		</div>
	);
}

function ConnectorSettingsBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [status, setStatus] = useState<ConnectorStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			setStatus(await connectorGetStatus());
		} catch {
			// ignore probe failures in settings
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useTauriEvent(events.connectorStatus, (payload) => {
		setStatus(payload);
	});

	const onToggle = async (enabled: boolean) => {
		patch({ connectorEnabled: enabled });
		if (!isTauri()) return;
		setBusy(true);
		try {
			const next = await connectorSetEnabled(enabled);
			setStatus(next);
			if (enabled && next.lastError) {
				notifyError(next.lastError);
			}
		} catch (e) {
			notifyError(errorText(e));
			patch({ connectorEnabled: false });
		} finally {
			setBusy(false);
		}
	};

	const onPortBlur = async (value: string) => {
		const port = Number.parseInt(value, 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			notifyError(t("general.connector.invalidPort"));
			return;
		}
		patch({ connectorPort: port });
		if (!isTauri()) return;
		try {
			setStatus(await connectorSetPort(port));
		} catch (e) {
			notifyError(errorText(e));
		}
	};

	return (
		<SettingsGroup>
			<SettingsRow
				label={
					<span className="inline-flex items-center gap-1.5">
						{t("general.connector.label")}
						<span className="text-caption font-normal leading-none text-muted-foreground/60">
							{t("general.connector.hint")}
						</span>
					</span>
				}
				htmlFor="connector-enabled"
			>
				<Switch
					id="connector-enabled"
					checked={settings.connectorEnabled}
					disabled={busy}
					onCheckedChange={(v) => void onToggle(v)}
				/>
			</SettingsRow>
			<SettingsRow
				label={
					<>
						{t("general.connector.portLabel")}
						{status?.listening ? (
							<span className="ml-1.5">
								<StatusDot tone="ok" label={t("common:listening")} />
							</span>
						) : null}
					</>
				}
				htmlFor="connector-port"
			>
				<Input
					id="connector-port"
					type="number"
					min={1}
					max={65535}
					className="h-8 w-28"
					defaultValue={settings.connectorPort}
					onBlur={(e) => void onPortBlur(e.currentTarget.value)}
					disabled={busy}
				/>
			</SettingsRow>
		</SettingsGroup>
	);
}

function McpSettingsBlock({
	settings,
	patch,
	disabled,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	disabled: boolean;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [status, setStatus] = useState<McpStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			setStatus(await mcpGetStatus());
		} catch {
			// ignore probe failures in settings
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useTauriEvent(events.mcpStatus, (payload) => {
		setStatus(payload);
	});

	const onToggle = async (enabled: boolean) => {
		patch({ mcpEnabled: enabled });
		if (!isTauri()) return;
		setBusy(true);
		try {
			const next = await mcpSetEnabled(enabled);
			setStatus(next);
			if (enabled && next.lastError) {
				notifyError(next.lastError);
			}
		} catch (e) {
			notifyError(errorText(e));
			patch({ mcpEnabled: false });
		} finally {
			setBusy(false);
		}
	};

	const onPortBlur = async (value: string) => {
		const port = Number.parseInt(value, 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			notifyError(t("general.mcp.invalidPort"));
			return;
		}
		patch({ mcpPort: port });
		if (!isTauri()) return;
		try {
			setStatus(await mcpSetPort(port));
		} catch (e) {
			notifyError(errorText(e));
		}
	};

	const url = status?.url ?? null;

	return (
		<SettingsGroup>
			<SettingsRow label={t("general.mcp.label")} htmlFor="mcp-enabled">
				<Switch
					id="mcp-enabled"
					checked={settings.mcpEnabled}
					disabled={busy || disabled}
					onCheckedChange={(v) => void onToggle(v)}
				/>
			</SettingsRow>
			<SettingsRow
				label={
					<>
						{t("general.mcp.portLabel")}
						{status?.listening ? (
							<span className="ml-1.5">
								<StatusDot tone="ok" label={t("common:listening")} />
							</span>
						) : null}
					</>
				}
				htmlFor="mcp-port"
			>
				<div className="flex items-center gap-2">
					<Input
						id="mcp-port"
						type="number"
						min={1}
						max={65535}
						className="h-8 w-28"
						defaultValue={settings.mcpPort}
						onBlur={(e) => void onPortBlur(e.currentTarget.value)}
						disabled={busy || disabled}
					/>
					{url ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-8"
									aria-label={t("general.mcp.copyUrl")}
									onClick={() => {
										void copyTextToClipboard(url).then((ok) => {
											if (!ok) return;
											setCopied(true);
											window.setTimeout(() => setCopied(false), 1500);
										});
									}}
								>
									<Copy className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{copied ? t("general.mcp.copied") : t("general.mcp.copyUrl")}
							</TooltipContent>
						</Tooltip>
					) : null}
				</div>
			</SettingsRow>
			{settings.mcpEnabled && (
				<McpTunnelRows
					settings={settings}
					patch={patch}
					disabled={disabled || busy}
					mcpListening={status?.listening ?? false}
					mcpUrl={url}
				/>
			)}
		</SettingsGroup>
	);
}

const TUNNEL_ID_RE = /^tunnel_[0-9a-f]{32}$/;
const TUNNEL_INSTALL_COMMAND = "brew install openai/tools/tunnel-client";

function tunnelPhaseTone(
	phase: McpTunnelPhase,
): "ok" | "idle" | "warn" | "err" {
	switch (phase) {
		case "ready":
			return "ok";
		case "starting":
			return "warn";
		case "error":
		case "binaryMissing":
			return "err";
		default:
			return "idle";
	}
}

function McpTunnelRows({
	settings,
	patch,
	disabled,
	mcpListening,
	mcpUrl,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	disabled: boolean;
	mcpListening: boolean;
	mcpUrl: string | null;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [status, setStatus] = useState<McpTunnelStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [tunnelIdDraft, setTunnelIdDraft] = useState(settings.mcpTunnelId);
	const [keyDraft, setKeyDraft] = useState(settings.mcpTunnelApiKey);
	const [installCopied, setInstallCopied] = useState(false);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			setStatus(await mcpTunnelStatus());
		} catch {
			// ignore probe failures in settings
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Start stays disabled while the host still reports BinaryMissing.
	// Poll so a brew install in another terminal is picked up without
	// restarting Agentero or reopening this page.
	useEffect(() => {
		if (status?.phase !== "binaryMissing") return;
		const id = window.setInterval(() => {
			void refresh();
		}, 2000);
		const onFocus = () => {
			void refresh();
		};
		window.addEventListener("focus", onFocus);
		return () => {
			window.clearInterval(id);
			window.removeEventListener("focus", onFocus);
		};
	}, [status?.phase, refresh]);

	useTauriEvent(events.mcpTunnelStatus, (payload) => {
		setStatus(payload);
	});

	const commitTunnelId = (value: string) => {
		const id = value.trim().toLowerCase().replace(/\s+/g, "");
		setTunnelIdDraft(id);
		if (id && !TUNNEL_ID_RE.test(id)) {
			notifyError(t("general.mcp.tunnel.invalidTunnelId"));
		}
		patch({ mcpTunnelId: id });
	};

	const commitKey = (value: string) => {
		const key = value.trim();
		setKeyDraft(key);
		patch({ mcpTunnelApiKey: key });
	};

	const start = async () => {
		if (!mcpUrl || !isTauri()) return;
		setBusy(true);
		try {
			const next = await mcpTunnelStart(mcpUrl);
			setStatus(next);
			if (next.lastError) {
				notifyError(next.lastError);
			}
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const stop = async () => {
		if (!isTauri()) return;
		setBusy(true);
		try {
			setStatus(await mcpTunnelStop());
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const phase = status?.phase ?? "stopped";
	const running = status?.running ?? false;
	const binaryMissing = phase === "binaryMissing";
	const installCommand = status?.installCommand ?? TUNNEL_INSTALL_COMMAND;

	const phaseLabel = {
		binaryMissing: t("general.mcp.tunnel.binaryMissing"),
		stopped: t("general.mcp.tunnel.stopped"),
		starting: t("general.mcp.tunnel.starting"),
		ready: t("general.mcp.tunnel.ready"),
		error: t("general.mcp.tunnel.error"),
	}[phase];

	return (
		<>
			<SettingsRow
				label={t("general.mcp.tunnel.apiKeyLabel")}
				htmlFor="mcp-tunnel-key"
			>
				<div className="flex items-center gap-2">
					<Input
						id="mcp-tunnel-key"
						type="password"
						autoComplete="off"
						className="h-8 w-full max-w-[18rem] font-mono text-xs"
						value={keyDraft}
						disabled={disabled || running}
						onChange={(e) => setKeyDraft(e.currentTarget.value)}
						onBlur={(e) => commitKey(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								commitKey(e.currentTarget.value);
							}
						}}
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={t("general.mcp.tunnel.openApiKeys")}
								onClick={() =>
									void openExternalUrl(
										"https://platform.openai.com/settings/organization/api-keys",
									)
								}
							>
								<ExternalLink className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("general.mcp.tunnel.openApiKeys")}
						</TooltipContent>
					</Tooltip>
				</div>
			</SettingsRow>
			<SettingsRow
				label={t("general.mcp.tunnel.tunnelIdLabel")}
				htmlFor="mcp-tunnel-id"
			>
				<div className="flex items-center gap-2">
					<Input
						id="mcp-tunnel-id"
						className="h-8 w-full max-w-[18rem] font-mono text-xs"
						value={tunnelIdDraft}
						disabled={disabled || running}
						onChange={(e) => setTunnelIdDraft(e.currentTarget.value)}
						onBlur={(e) => commitTunnelId(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								commitTunnelId(e.currentTarget.value);
							}
						}}
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={t("general.mcp.tunnel.openTunnels")}
								onClick={() =>
									void openExternalUrl(
										"https://platform.openai.com/settings/organization/tunnels",
									)
								}
							>
								<ExternalLink className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("general.mcp.tunnel.openTunnels")}
						</TooltipContent>
					</Tooltip>
				</div>
			</SettingsRow>
			<SettingsRow label={t("general.mcp.tunnel.label")}>
				<div className="flex items-center gap-2">
					<StatusDot tone={tunnelPhaseTone(phase)} label={phaseLabel} />
					<Button
						type="button"
						size="sm"
						disabled={disabled || busy || binaryMissing || !mcpListening}
						onClick={() => void (running ? stop() : start())}
					>
						{busy ? (
							<LoaderCircle className="mr-1.5 size-4 animate-spin" />
						) : (
							<Power className="mr-1.5 size-4" />
						)}
						{running
							? t("general.mcp.tunnel.stop")
							: t("general.mcp.tunnel.start")}
					</Button>
				</div>
			</SettingsRow>
			{binaryMissing && (
				<div className="px-3 pb-2 text-muted-foreground text-xs">
					<p className="mb-1.5">{t("general.mcp.tunnel.installHint")}</p>
					<div className="flex items-center gap-2">
						<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-caption">
							{installCommand}
						</code>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label={t("general.mcp.tunnel.copyCommand")}
									onClick={() => {
										void copyTextToClipboard(installCommand).then((ok) => {
											if (!ok) return;
											setInstallCopied(true);
											window.setTimeout(() => setInstallCopied(false), 1500);
										});
									}}
								>
									<Copy className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{installCopied
									? t("general.mcp.tunnel.copied")
									: t("general.mcp.tunnel.copyCommand")}
							</TooltipContent>
						</Tooltip>
					</div>
				</div>
			)}
		</>
	);
}
