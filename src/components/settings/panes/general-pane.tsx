import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NetworkProxyRow } from "@/components/settings/agent-common-rows";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
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
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
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
} from "@/lib/settings";
import { DEFAULT_NETWORK_PROXY_URL } from "@/lib/settings/defaults";

export function GeneralPane({
	settings,
	patch,
	hostContext,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	hostContext: SettingsHostContext;
}) {
	const { t } = useTranslation("settings");
	const [proxyUrlDraft, setProxyUrlDraft] = useState(settings.networkProxyUrl);

	useEffect(() => {
		setProxyUrlDraft(settings.networkProxyUrl);
	}, [settings.networkProxyUrl]);

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
				<NetworkProxyRow
					htmlFor="network-proxy-enabled"
					label={t("general.networkProxy.label")}
					description={t("general.networkProxy.description")}
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
			<ConnectorSettingsBlock settings={settings} patch={patch} />
			<RemoteCacheSettingsBlock />
			<ExportSettingsBlock settings={settings} patch={patch} />
			<TelemetrySettingsBlock settings={settings} patch={patch} />
		</>
	);
}

function TelemetrySettingsBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	const [busy, setBusy] = useState(false);

	const onSend = async () => {
		if (!isTauri() || busy) return;
		if (!settings.telemetryEnabled) {
			notifyError(t("general.telemetry.disabledHint"));
			return;
		}
		setBusy(true);
		try {
			const { invokeApi } = await import("@/lib/core/ipc");
			const result = await invokeApi<{ enabled: boolean; sent: boolean }>(
				"telemetry_send_diagnostics",
			);
			if (result.sent) {
				notifySuccess(t("general.telemetry.sent"));
			} else {
				notifyError(t("general.telemetry.sendFailed"));
			}
		} catch (e) {
			notifyError(
				e instanceof Error ? e.message : t("general.telemetry.sendFailed"),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mt-4">
			<p className="mb-2 px-0.5 font-medium text-[13px]">
				{t("general.telemetry.section")}
			</p>
			<SettingsGroup>
				<SettingsRow
					label={
						<span className="inline-flex flex-col gap-0.5">
							{t("general.telemetry.label")}
							<span className="text-[11px] font-normal leading-snug text-muted-foreground/70">
								{t("general.telemetry.description")}
							</span>
						</span>
					}
					htmlFor="telemetry-enabled"
				>
					<Switch
						id="telemetry-enabled"
						checked={settings.telemetryEnabled}
						onCheckedChange={(v) => patch({ telemetryEnabled: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("general.telemetry.sendLabel")}>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-8"
						disabled={busy || !isTauri() || !settings.telemetryEnabled}
						onClick={() => void onSend()}
					>
						{busy
							? t("general.telemetry.sending")
							: t("general.telemetry.send")}
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
			<p className="mb-2 px-0.5 font-medium text-[13px]">
				{t("general.export.section")}
			</p>
			<SettingsGroup>
				<SettingsRow
					label={
						<span className="inline-flex flex-col gap-0.5">
							{t("general.export.watermark.label")}
							<span className="text-[11px] font-normal leading-snug text-muted-foreground/70">
								{t("general.export.watermark.description")}
							</span>
						</span>
					}
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

function RemoteCacheSettingsBlock() {
	const { t } = useTranslation("settings");
	const [busy, setBusy] = useState(false);

	const onClear = async () => {
		if (!isTauri() || busy) return;
		setBusy(true);
		try {
			const { remoteCacheClear } = await import(
				"@/lib/vault/remote/remote-vault"
			);
			await remoteCacheClear();
		} catch (e) {
			notifyError(
				e instanceof Error ? e.message : t("general.remoteCache.clearFailed"),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mt-4">
			<p className="mb-2 px-0.5 font-medium text-[13px]">
				{t("general.remoteCache.section")}
			</p>
			<SettingsGroup>
				<SettingsRow label={t("general.remoteCache.label")}>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-8"
						disabled={busy || !isTauri()}
						onClick={() => void onClear()}
					>
						{busy
							? t("general.remoteCache.clearing")
							: t("general.remoteCache.clear")}
					</Button>
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
	const { t } = useTranslation("settings");
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

	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		const unsubs: Array<() => void> = [];
		void (async () => {
			const { listen } = await import("@tauri-apps/api/event");
			if (cancelled) return;
			unsubs.push(
				await listen<ConnectorStatus>("connector:status", (e) => {
					setStatus(e.payload);
				}),
			);
		})();
		return () => {
			cancelled = true;
			for (const u of unsubs) u();
		};
	}, []);

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
			notifyError(e instanceof Error ? e.message : String(e));
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
			notifyError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<SettingsGroup>
			<SettingsRow
				label={
					<span className="inline-flex items-center gap-1.5">
						{t("general.connector.label")}
						<span className="text-[11px] font-normal leading-none text-muted-foreground/60">
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
							<span
								role="img"
								aria-label="listening"
								className="ml-1.5 inline-block size-2 rounded-full bg-emerald-500 align-middle"
							/>
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
