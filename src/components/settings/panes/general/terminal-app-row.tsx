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

/** Radix disallows empty item values; this sentinel maps to "system default". */
const SYSTEM_DEFAULT = "system-default";

/**
 * Preferred terminal for "Open in Terminal". Only installed terminals are
 * selectable; a saved but now-missing app stays visible as unavailable and the
 * Host falls back to the system default (see `app/terminal`).
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

	return (
		<SettingsRow label={t("general.terminalApp.label")}>
			<Select
				value={value || SYSTEM_DEFAULT}
				onValueChange={(next) => onChange(next === SYSTEM_DEFAULT ? "" : next)}
			>
				<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={SYSTEM_DEFAULT}>
						{t("general.terminalApp.systemDefault")}
					</SelectItem>
					{installed.map((app) => (
						<SelectItem key={app.id} value={app.id}>
							{app.name}
						</SelectItem>
					))}
					{unavailable ? (
						<SelectItem value={value} disabled>
							{unavailableLabel}
						</SelectItem>
					) : null}
				</SelectContent>
			</Select>
		</SettingsRow>
	);
}
