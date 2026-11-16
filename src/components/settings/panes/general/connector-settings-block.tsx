import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { StatusDot } from "@/components/settings/status-dot";
import { WordSettings } from "@/components/settings/word-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import {
	type ConnectorStatus,
	connectorGetStatus,
	connectorSetEnabled,
	connectorSetPort,
} from "@/lib/paper/import/connector";
import { connectorStatusError } from "@/lib/paper/import/connector-errors";
import type { AppSettings } from "@/lib/settings";

export function ConnectorSettingsBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [status, setStatus] = useState<ConnectorStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const statusError =
		settings.connectorEnabled && status?.enabled && !status.listening
			? connectorStatusError(status, t)
			: null;

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
			const message = connectorStatusError(next, t);
			if (enabled && message) {
				notifyError(message);
			}
		} catch (e) {
			notifyError(errorText(e));
			patch({ connectorEnabled: false });
		} finally {
			setBusy(false);
		}
	};

	const onRetry = async () => {
		if (!isTauri()) return;
		setBusy(true);
		try {
			const next = await connectorSetEnabled(true);
			setStatus(next);
			const message = connectorStatusError(next, t);
			if (message) notifyError(message);
		} catch (e) {
			notifyError(errorText(e));
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
						) : statusError ? (
							<span className="ml-1.5" role="status">
								<StatusDot
									tone="err"
									label={t("general.connector.notListening")}
								/>
							</span>
						) : null}
					</>
				}
				description={statusError ?? undefined}
				htmlFor="connector-port"
			>
				{statusError ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						title={t("common:tryAgain")}
						aria-label={t("common:tryAgain")}
						disabled={busy}
						onClick={() => void onRetry()}
					>
						<RotateCw aria-hidden="true" />
					</Button>
				) : null}
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
			<WordSettings />
		</SettingsGroup>
	);
}
