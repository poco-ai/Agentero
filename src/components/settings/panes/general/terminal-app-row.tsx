import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings/settings-layout";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { isTauri } from "@/lib/core/tauri";
import {
	probeTerminalApps,
	type TerminalAppStatus,
} from "@/lib/system/terminal-apps";
import { TerminalAppLogo } from "./terminal-app-logo";

/** `terminalApp` value meaning "let the desktop decide which terminal to open". */
const SYSTEM_DEFAULT = "system";

/**
 * Terminal used by "Open in Terminal" and the Agent terminal / login buttons.
 * Only installed terminals are selectable; a saved but now-missing app stays
 * visible as unavailable and the Host falls back to the system default
 * (see `app/terminal`).
 *
 * "System default" is always offered, so a user whose terminal is not in the
 * probe list can still choose something instead of facing an empty dropdown.
 */
export function TerminalAppRow({
	value,
	onChange,
}: {
	value: string;
	onChange: (id: string) => void;
}) {
	const { t } = useTranslation("settings");
	const [apps, setApps] = useState<TerminalAppStatus[]>([]);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		if (!isTauri()) {
			setLoaded(true);
			return;
		}
		let cancelled = false;
		void probeTerminalApps()
			.then((list) => {
				if (!cancelled) setApps(list);
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const installed = apps.filter((app) => app.installed);
	const saved = apps.find((app) => app.id === value);
	const unavailableLabel = saved
		? t("general.terminalApp.unavailable", { name: saved.name })
		: t("general.terminalApp.unavailable", { name: value });
	const unavailable =
		loaded && Boolean(value) && !installed.some((app) => app.id === value);
	// An empty preference opens the same thing as an explicit system default.
	const selected = value || SYSTEM_DEFAULT;
	const noTerminalHint = t("general.terminalApp.noneDetected");
	const empty = loaded && !installed.length;

	return (
		<SettingsRow
			label={t("general.terminalApp.label")}
			description={empty ? noTerminalHint : undefined}
		>
			<Select value={selected} onValueChange={onChange}>
				<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={SYSTEM_DEFAULT}>
						<TerminalAppLogo id={SYSTEM_DEFAULT} />
						{t("general.terminalApp.systemDefault")}
					</SelectItem>
					<div className="my-1 h-px bg-border" aria-hidden />
					{installed.map((app) => (
						<SelectItem key={app.id} value={app.id}>
							<TerminalAppLogo id={app.id} />
							{app.name}
						</SelectItem>
					))}
					{unavailable ? (
						<SelectItem value={value} disabled>
							<TerminalAppLogo id={value} />
							{unavailableLabel}
						</SelectItem>
					) : null}
				</SelectContent>
			</Select>
		</SettingsRow>
	);
}
