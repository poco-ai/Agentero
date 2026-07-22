import {
	Bot,
	Check,
	CheckCircle2,
	Circle,
	Info,
	Keyboard,
	Languages,
	Loader2,
	Paintbrush,
	Plus,
	RefreshCw,
	Shield,
	SlidersHorizontal,
	Terminal,
	Trash2,
	X,
	XCircle,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { HostOsIcon, normalizeHostOs } from "@/components/host-os-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import {
	type AgentListResponse,
	type AgentTemplate,
	acpStatusLabel,
	type CatalogEntry,
	type CatalogScanResponse,
	ensureCatalogAgent,
	listAgents,
	loadModelCatalog,
	openInstallTerminal,
	type ProbeResult,
	probeAgent,
	probeCatalogAgent,
	removeAgent,
	scanCatalog,
	setAgentEnabled,
	setAgentProxy,
	upsertAgent,
	warmAgent,
} from "@/lib/agent";
import {
	type ConnectorStatus,
	connectorGetStatus,
	connectorSetEnabled,
	connectorSetPort,
} from "@/lib/connector";
import { notifyError } from "@/lib/notify";
import {
	PAPER_TREE_LABEL_MODES,
	PAPER_TREE_SORT_MODES,
	type PaperTreeLabelMode,
	type PaperTreeSortMode,
} from "@/lib/paper-metadata";
import {
	fetchHostIdentity,
	fetchRemoteHostIdentity,
	getRemoteSessionMeta,
	isRemoteVaultHandle,
	remoteAgentOpenInstallTerminal,
	remoteAgentProbe,
	remoteAgentScan,
	remoteSessionIdFromHandle,
} from "@/lib/remote-vault";
import { revealInOsLabelKey } from "@/lib/reveal";
import {
	type AgentPermissionMode,
	type AiResponseLanguage,
	type AppSettings,
	DEFAULT_TRANSLATOR_BASE_URL,
	type LocalePreference,
	type PdfAskSettings,
	type ThemePreference,
	type TranslateProviderId,
	type TranslateTargetLang,
} from "@/lib/settings";
import {
	catalogNeedsProbe,
	catalogProbeKey,
	catalogStatusTone,
	customProbeKey,
	formatBytes,
	patchCatalogProbe,
	patchCustomProbe,
} from "@/lib/settings-probe";
import {
	formatShortcut,
	type ShortcutDef,
	type ShortcutGroup,
	shortcutsByGroup,
} from "@/lib/shortcuts";
import { getPlatformOS, isTauri } from "@/lib/tauri";
import {
	FREE_MT_PROVIDER_IDS,
	type FreeMtProbeMap,
	type FreeMtProbeStatus,
	isFreeMtProvider,
	listAvailableAgents,
	listSelectableProviders,
	probeFreeMtProviders,
} from "@/lib/translate";
import { applyUiTheme, DEFAULT_UI_THEME, UI_THEMES } from "@/lib/ui-theme";
import { cn } from "@/lib/utils";

export type SettingsSection =
	| "general"
	| "appearance"
	| "agent"
	| "translate"
	| "keyboard"
	| "privacy"
	| "about";

/** Which machine the Agent catalog / probe targets. */
export type SettingsHostContext =
	| { kind: "local"; label: string }
	| {
			kind: "remote";
			label: string;
			sessionId: string;
			host: string;
			remotePath: string;
	  };

const NAV: {
	id: SettingsSection;
	icon: typeof Bot;
}[] = [
	{ id: "general", icon: SlidersHorizontal },
	{ id: "appearance", icon: Paintbrush },
	{ id: "agent", icon: Bot },
	{ id: "translate", icon: Languages },
	{ id: "keyboard", icon: Keyboard },
	{ id: "privacy", icon: Shield },
	{ id: "about", icon: Info },
];

const GROUP_KEY: Record<ShortcutGroup, "app" | "navigation" | "vault"> = {
	App: "app",
	Navigation: "navigation",
	Vault: "vault",
};

type SettingsWindowProps = {
	open: boolean;
	section: SettingsSection;
	onSectionChange: (section: SettingsSection) => void;
	onClose: () => void;
	settings: AppSettings;
	onChange: (next: AppSettings) => void;
	/** Active vault path — remote handles switch Agent settings to the SSH host. */
	vaultPath?: string | null;
};

/** In-app modal fallback (non-Tauri / browser dev); Tauri opens a native window. */
export function SettingsWindow({
	open,
	section,
	onSectionChange,
	onClose,
	settings,
	onChange,
	vaultPath = null,
}: SettingsWindowProps) {
	const { t } = useTranslation(["settings", "common"]);
	const titleId = useId();

	useOverlayRegistration("settings", open, onClose);

	useEffect(() => {
		if (!open) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, [open]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-6">
			<button
				type="button"
				className="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
				aria-label={t("dismiss")}
				onClick={onClose}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className="relative flex h-[min(560px,calc(100vh-3rem))] w-[min(720px,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-background shadow-2xl ring-1 ring-black/5"
			>
				<SettingsContent
					titleId={titleId}
					section={section}
					onSectionChange={onSectionChange}
					onClose={onClose}
					settings={settings}
					onChange={onChange}
					vaultPath={vaultPath}
				/>
			</div>
		</div>
	);
}

type SettingsContentProps = {
	section: SettingsSection;
	onSectionChange: (section: SettingsSection) => void;
	settings: AppSettings;
	onChange: (next: AppSettings) => void;
	/** Renders a close (X) button when provided (modal mode). */
	onClose?: () => void;
	/** aria-labelledby id supplied by a dialog wrapper. */
	titleId?: string;
	/** Active vault path — remote handles switch Agent settings to the SSH host. */
	vaultPath?: string | null;
};

/** Settings navigation + panes; used by the native settings window and the modal fallback. */
export function SettingsContent({
	section,
	onSectionChange,
	settings,
	onChange,
	onClose,
	titleId,
	vaultPath = null,
}: SettingsContentProps) {
	const { t } = useTranslation(["settings", "common"]);
	const fallbackTitleId = useId();
	const headingId = titleId ?? fallbackTitleId;
	const [localHostLabel, setLocalHostLabel] = useState(() =>
		t("host.thisComputer"),
	);
	const [localOs, setLocalOs] = useState(() =>
		normalizeHostOs(getPlatformOS()),
	);
	const [remoteOs, setRemoteOs] = useState(() => normalizeHostOs("other"));

	// Local hostname + OS for the host chip (when vault is local / none).
	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		void fetchHostIdentity()
			.then((h) => {
				if (cancelled) return;
				if (h.label.trim()) setLocalHostLabel(h.label.trim());
				setLocalOs(normalizeHostOs(h.os));
			})
			.catch(() => {
				/* keep fallback */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const hostContext = useMemo((): SettingsHostContext => {
		if (vaultPath && isRemoteVaultHandle(vaultPath)) {
			const sessionId = remoteSessionIdFromHandle(vaultPath);
			const meta = getRemoteSessionMeta();
			if (sessionId && meta && meta.sessionId === sessionId) {
				const label =
					meta.host.trim() ||
					meta.displayName.split(":")[0]?.trim() ||
					t("host.remote");
				return {
					kind: "remote",
					label,
					sessionId,
					host: meta.host,
					remotePath: meta.remotePath,
				};
			}
			if (sessionId) {
				return {
					kind: "remote",
					label: t("host.remote"),
					sessionId,
					host: "",
					remotePath: "",
				};
			}
		}
		return { kind: "local", label: localHostLabel };
	}, [vaultPath, localHostLabel, t]);

	// Remote OS via uname -s (for brand icon on remote host chip).
	useEffect(() => {
		if (!isTauri() || hostContext.kind !== "remote") {
			return;
		}
		let cancelled = false;
		setRemoteOs(normalizeHostOs("other"));
		void fetchRemoteHostIdentity(hostContext.sessionId)
			.then((info) => {
				if (!cancelled) setRemoteOs(normalizeHostOs(info.os));
			})
			.catch(() => {
				if (!cancelled) setRemoteOs(normalizeHostOs("other"));
			});
		return () => {
			cancelled = true;
		};
	}, [hostContext]);

	const hostOs = hostContext.kind === "remote" ? remoteOs : localOs;

	const patch = (partial: Partial<AppSettings>) =>
		onChange({ ...settings, ...partial });

	return (
		<>
			{/* Sidebar — macOS Settings style */}
			<nav className="flex w-[180px] shrink-0 flex-col border-r bg-muted/40">
				{/* Modal fallback only: native window already shows the title in its title bar. */}
				{onClose ? (
					<div className="flex items-center justify-between gap-1 px-3 pt-3 pb-2">
						<span
							id={headingId}
							className="font-semibold text-[13px] leading-none tracking-tight"
						>
							{t("title")}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="shrink-0"
							aria-label={t("common:close")}
							onClick={onClose}
						>
							<X className="size-3.5" />
						</Button>
					</div>
				) : null}
				<ul
					className={cn(
						"flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2",
						!onClose && "pt-3",
					)}
				>
					{NAV.map((item) => {
						const Icon = item.icon;
						const active = section === item.id;
						return (
							<li key={item.id}>
								<button
									type="button"
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors",
										"hover:bg-black/5 dark:hover:bg-white/10",
										active &&
											"bg-primary text-primary-foreground hover:bg-primary dark:hover:bg-primary",
									)}
									aria-current={active ? "page" : undefined}
									onClick={() => onSectionChange(item.id)}
								>
									<Icon className="size-3.5 shrink-0 opacity-90" />
									<span className="truncate">{t(`nav.${item.id}`)}</span>
								</button>
							</li>
						);
					})}
				</ul>
				{/* Host context — pinned to sidebar footer */}
				<div
					className="mt-auto flex items-center gap-1.5 border-t px-3 py-2.5 text-muted-foreground"
					title={
						hostContext.kind === "remote"
							? t("host.remoteTooltip", {
									host: hostContext.label,
									path: hostContext.remotePath || "—",
								})
							: t("host.localTooltip", { name: hostContext.label })
					}
				>
					<span className="inline-flex size-3.5 shrink-0 items-center justify-center">
						<HostOsIcon
							os={hostOs}
							className="block size-3.5"
							title={
								hostOs === "macos"
									? "macOS"
									: hostOs === "windows"
										? "Windows"
										: hostOs === "linux"
											? "Linux"
											: undefined
							}
						/>
					</span>
					<span className="min-w-0 truncate text-[12px] leading-none">
						{hostContext.label}
					</span>
				</div>
			</nav>

			{/* Content */}
			<div className="min-w-0 flex-1 overflow-y-auto">
				<div className="px-6 py-5">
					{section === "general" && (
						<GeneralPane
							settings={settings}
							patch={patch}
							hostContext={hostContext}
						/>
					)}
					{section === "appearance" && (
						<AppearancePane settings={settings} patch={patch} />
					)}
					{section === "agent" &&
						(hostContext.kind === "remote" ? (
							<RemoteAgentPane
								settings={settings}
								patch={patch}
								hostContext={hostContext}
							/>
						) : (
							<AgentPane settings={settings} patch={patch} />
						))}
					{section === "translate" && (
						<TranslatePane
							settings={settings}
							patch={patch}
							onOpenAgentSettings={() => onSectionChange("agent")}
						/>
					)}
					{section === "keyboard" && <KeyboardPane />}
					{section === "privacy" && (
						<PrivacyPane settings={settings} patch={patch} />
					)}
					{section === "about" && <AboutPane />}
				</div>
			</div>
		</>
	);
}

function PageTitle({ title }: { title: string }) {
	return <h2 className="mb-4 font-semibold text-lg tracking-tight">{title}</h2>;
}

function SettingsGroup({ children }: { children: ReactNode }) {
	return (
		<div className="mb-5">
			<div className="overflow-hidden rounded-xl border bg-card">
				{children}
			</div>
		</div>
	);
}

function SettingsRow({
	label,
	htmlFor,
	description,
	children,
}: {
	label: string;
	htmlFor?: string;
	/** Optional muted secondary line under the label. */
	description?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4 border-b px-3.5 py-2.5 last:border-b-0">
			<div className="min-w-0">
				<Label htmlFor={htmlFor} className="font-normal text-[13px]">
					{label}
				</Label>
				{description ? (
					<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
						{description}
					</p>
				) : null}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

function GeneralPane({
	settings,
	patch,
	hostContext,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	hostContext: SettingsHostContext;
}) {
	const { t } = useTranslation("settings");
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
				<SettingsRow
					label={t("general.restoreVault.label")}
					htmlFor="restore-vault"
				>
					<Switch
						id="restore-vault"
						checked={settings.restoreLastVault}
						onCheckedChange={(v) => patch({ restoreLastVault: v })}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("general.confirmClose.label")}
					htmlFor="confirm-close"
				>
					<Switch
						id="confirm-close"
						checked={settings.confirmBeforeClose}
						onCheckedChange={(v) => patch({ confirmBeforeClose: v })}
					/>
				</SettingsRow>
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
			</SettingsGroup>
			<p className="px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("general.paperTreeLabelMode.hint")}
			</p>
			<p className="px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("general.paperTreeSortMode.hint")}
			</p>
			<SettingsGroup>
				<div className="flex flex-col gap-1.5 border-b px-3.5 py-2.5 last:border-b-0">
					<Label
						htmlFor="translator-base-url"
						className="font-normal text-[13px]"
					>
						{t("general.translatorBaseUrl.label")}
					</Label>
					<Input
						id="translator-base-url"
						value={settings.translatorBaseUrl}
						onChange={(e) => patch({ translatorBaseUrl: e.target.value })}
						onBlur={() => {
							const trimmed = settings.translatorBaseUrl
								.trim()
								.replace(/\/+$/, "");
							if (!trimmed) {
								patch({ translatorBaseUrl: DEFAULT_TRANSLATOR_BASE_URL });
							} else if (trimmed !== settings.translatorBaseUrl) {
								patch({ translatorBaseUrl: trimmed });
							}
						}}
						placeholder={DEFAULT_TRANSLATOR_BASE_URL}
						className="h-8 font-mono text-xs"
						spellCheck={false}
						autoComplete="off"
					/>
				</div>
			</SettingsGroup>
			<p className="px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("general.translatorBaseUrl.hint")}
			</p>
			<ConnectorSettingsBlock settings={settings} patch={patch} />
			<RemoteCacheSettingsBlock />
		</>
	);
}

function RemoteCacheSettingsBlock() {
	const { t } = useTranslation("settings");
	const [stats, setStats] = useState<{
		bytes: number;
		files: number;
		maxBytes: number;
	} | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const { remoteCacheStats } = await import("@/lib/remote-vault");
			const s = await remoteCacheStats();
			setStats({ bytes: s.bytes, files: s.files, maxBytes: s.maxBytes });
		} catch {
			setStats(null);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const onClear = async () => {
		if (!isTauri() || busy) return;
		setBusy(true);
		try {
			const { remoteCacheClear } = await import("@/lib/remote-vault");
			await remoteCacheClear();
			await refresh();
		} catch (e) {
			notifyError(
				e instanceof Error ? e.message : t("general.remoteCache.clearFailed"),
			);
		} finally {
			setBusy(false);
		}
	};

	const sizeLine = stats
		? t("general.remoteCache.size", {
				used: formatBytes(stats.bytes),
				files: stats.files,
				max: formatBytes(stats.maxBytes),
			})
		: t("general.remoteCache.sizeUnknown");

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
			<p className="mt-2 px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("general.remoteCache.hint")}
			</p>
			<p className="px-0.5 font-mono text-[11px] text-muted-foreground leading-relaxed">
				{sizeLine}
			</p>
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

	const statusLine = (() => {
		if (!isTauri()) return t("general.connector.desktopOnly");
		if (!status) {
			return settings.connectorEnabled
				? t("general.connector.statusStarting")
				: t("general.connector.statusOff");
		}
		if (status.lastError) {
			return t("general.connector.statusError", {
				message: status.lastError,
			});
		}
		if (status.listening) {
			const base = t("general.connector.statusListening", {
				address: status.boundAddress ?? `127.0.0.1:${status.port}`,
			});
			if (!status.vaultPath) {
				return `${base} · ${t("general.connector.statusNoVault")}`;
			}
			return base;
		}
		if (settings.connectorEnabled) {
			return t("general.connector.statusStarting");
		}
		return t("general.connector.statusOff");
	})();

	return (
		<>
			<SettingsGroup>
				<SettingsRow
					label={t("general.connector.label")}
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
					label={t("general.connector.portLabel")}
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
			<p className="px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("general.connector.hint")}
			</p>
			<p className="px-0.5 font-mono text-[11px] text-muted-foreground leading-relaxed">
				{statusLine}
			</p>
		</>
	);
}

function AppearancePane({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	const { setTheme } = useTheme();
	const fontId = useId();

	const setThemePref = (theme: ThemePreference) => {
		patch({ theme });
		setTheme(theme);
	};

	return (
		<>
			<PageTitle title={t("appearance.title")} />
			<SettingsGroup>
				<SettingsRow label={t("appearance.themeLabel")}>
					<Select
						value={settings.theme}
						onValueChange={(v) => setThemePref(v as ThemePreference)}
					>
						<SelectTrigger size="sm" className="min-w-[120px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="system">
								{t("appearance.theme.system")}
							</SelectItem>
							<SelectItem value="light">
								{t("appearance.theme.light")}
							</SelectItem>
							<SelectItem value="dark">{t("appearance.theme.dark")}</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("appearance.uiThemeLabel")}>
					<Select
						value={settings.uiTheme}
						onValueChange={(v) => {
							patch({ uiTheme: v });
							applyUiTheme(v);
						}}
					>
						<SelectTrigger size="sm" className="min-w-[160px] max-w-[220px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={DEFAULT_UI_THEME}>
								{t("appearance.uiTheme.default")}
							</SelectItem>
							{UI_THEMES.map((theme) => (
								<SelectItem key={theme.name} value={theme.name}>
									{theme.title}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("appearance.languageLabel")}>
					<Select
						value={settings.locale}
						onValueChange={(v) => patch({ locale: v as LocalePreference })}
					>
						<SelectTrigger size="sm" className="min-w-[120px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="system">
								{t("appearance.language.system")}
							</SelectItem>
							<SelectItem value="en">{t("appearance.language.en")}</SelectItem>
							<SelectItem value="zh-CN">
								{t("appearance.language.zhCN")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsGroup>

			<p className="mb-1.5 mt-4 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{t("appearance.markdownEditor.section")}
			</p>
			<SettingsGroup>
				<SettingsRow label={t("appearance.fontSize.label")} htmlFor={fontId}>
					<div className="flex items-center gap-2">
						<input
							id={fontId}
							type="range"
							min={12}
							max={20}
							step={1}
							value={settings.editorFontSize}
							onChange={(e) =>
								patch({ editorFontSize: Number(e.target.value) })
							}
							className="w-28 accent-primary"
						/>
						<span className="w-12 text-right text-muted-foreground text-xs tabular-nums">
							{t("appearance.fontSize.value", {
								size: settings.editorFontSize,
							})}
						</span>
					</div>
				</SettingsRow>
				<SettingsRow
					label={t("appearance.editorToolbar.label")}
					htmlFor="editor-toolbar"
				>
					<Switch
						id="editor-toolbar"
						checked={settings.showEditorToolbar}
						onCheckedChange={(v) => patch({ showEditorToolbar: v })}
					/>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}

function StatusBadge({
	tone,
	children,
	className,
	title,
}: {
	tone: "ok" | "warn" | "err" | "muted" | "primary";
	children: ReactNode;
	className?: string;
	title?: string;
}) {
	return (
		<span
			title={title}
			className={cn(
				"inline-flex shrink-0 items-center justify-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none",
				tone === "ok" &&
					"bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
				tone === "warn" && "bg-amber-500/15 text-amber-800 dark:text-amber-400",
				tone === "err" && "bg-destructive/15 text-destructive",
				tone === "muted" && "bg-muted text-muted-foreground",
				tone === "primary" && "bg-primary/10 text-primary",
				className,
			)}
		>
			{children}
		</span>
	);
}

/** ACP badge while a probe is in flight (replaces static “not probed”). */
function ProbingBadge({ label }: { label: string }) {
	return (
		<StatusBadge tone="warn">
			<Loader2 className="size-2.5 shrink-0 animate-spin" aria-hidden />
			{label}
		</StatusBadge>
	);
}

const TRANSLATE_FOLLOW_AGENT = "__follow_default__";
const TRANSLATE_FOLLOW_MODEL = "__follow_model__";

/** Availability icon for free-MT providers in the default-service Select. */
function ProviderProbeIcon({
	status,
	labelIdle,
	labelOk,
	labelFail,
	labelProbing,
}: {
	status: FreeMtProbeStatus;
	labelIdle: string;
	labelOk: string;
	labelFail: string;
	labelProbing: string;
}) {
	if (status === "probing") {
		return (
			<Loader2
				className="size-3.5 shrink-0 animate-spin text-muted-foreground"
				aria-label={labelProbing}
			/>
		);
	}
	if (status === "ok") {
		return (
			<CheckCircle2
				className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
				aria-label={labelOk}
			/>
		);
	}
	if (status === "fail") {
		return (
			<XCircle
				className="size-3.5 shrink-0 text-destructive/80"
				aria-label={labelFail}
			/>
		);
	}
	// idle (not yet probed)
	return (
		<Circle
			className="size-3.5 shrink-0 text-muted-foreground/50"
			aria-label={labelIdle}
		/>
	);
}

function TranslatePane({
	settings,
	patch,
	onOpenAgentSettings,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	onOpenAgentSettings?: () => void;
}) {
	const { t } = useTranslation("settings");
	const tr = settings.translate;
	const providers = listSelectableProviders();
	const patchTranslate = useCallback(
		(partial: Partial<typeof tr>) =>
			patch({ translate: { ...tr, ...partial } }),
		[patch, tr],
	);
	const showEndpoint = tr.provider === "libre" || tr.freeBaseUrl.length > 0;
	const showAgent = tr.provider === "agent";

	const [registry, setRegistry] = useState<AgentListResponse | null>(null);
	const [models, setModels] = useState<{ id: string; name: string }[]>([]);
	/** Free-MT probe status (Agent never probed here). */
	const [probeMap, setProbeMap] = useState<FreeMtProbeMap>({});
	const probeAbortRef = useRef<AbortController | null>(null);
	const probingRef = useRef(false);

	/** Parallel free-MT probe when the default-service Select opens. */
	const runFreeMtProbe = useCallback(() => {
		if (!isTauri() || probingRef.current) return;
		probingRef.current = true;
		probeAbortRef.current?.abort();
		const ac = new AbortController();
		probeAbortRef.current = ac;

		const initial: FreeMtProbeMap = {};
		for (const id of FREE_MT_PROVIDER_IDS) {
			initial[id] = "probing";
		}
		setProbeMap(initial);

		void probeFreeMtProviders({
			freeBaseUrl: tr.freeBaseUrl,
			signal: ac.signal,
			onResult: (id, ok) => {
				if (ac.signal.aborted) return;
				setProbeMap((prev) => ({
					...prev,
					[id]: ok ? "ok" : "fail",
				}));
			},
		}).finally(() => {
			if (probeAbortRef.current === ac) {
				probingRef.current = false;
			}
		});
	}, [tr.freeBaseUrl]);

	useEffect(() => {
		return () => {
			probeAbortRef.current?.abort();
		};
	}, []);

	// Load agent registry when Agent provider is selected
	useEffect(() => {
		if (!showAgent || !isTauri()) {
			setRegistry(null);
			return;
		}
		let cancelled = false;
		void listAgents()
			.then((r) => {
				if (!cancelled) setRegistry(r);
			})
			.catch(() => {
				if (!cancelled) setRegistry(null);
			});
		return () => {
			cancelled = true;
		};
	}, [showAgent]);

	const availableAgents = listAvailableAgents(registry);
	const defaultAgent = registry?.defaultId
		? (availableAgents.find((a) => a.id === registry.defaultId) ??
			registry.agents.find((a) => a.id === registry.defaultId))
		: undefined;
	const resolvedAgentId = tr.agentId.trim() || registry?.defaultId || "";

	// Load model catalog for resolved agent; optional warm in background
	useEffect(() => {
		if (!showAgent || !resolvedAgentId) {
			setModels([]);
			return;
		}
		const cached = loadModelCatalog(resolvedAgentId);
		setModels(cached?.models ?? []);
		if (!isTauri()) return;
		let cancelled = false;
		void warmAgent({ agentId: resolvedAgentId }).catch(() => undefined);
		// Re-read catalog after a short delay (warm may fill it via events elsewhere;
		// settings pane only sees localStorage cache from prior Chat sessions).
		const tmr = window.setTimeout(() => {
			if (cancelled) return;
			const next = loadModelCatalog(resolvedAgentId);
			if (next?.models?.length) setModels(next.models);
		}, 800);
		return () => {
			cancelled = true;
			window.clearTimeout(tmr);
		};
	}, [showAgent, resolvedAgentId]);

	// Drop stale agentId / modelId
	useEffect(() => {
		if (!showAgent || !registry) return;
		if (tr.agentId && !availableAgents.some((a) => a.id === tr.agentId)) {
			patchTranslate({ agentId: "", modelId: "" });
			return;
		}
		if (
			tr.modelId &&
			models.length > 0 &&
			!models.some((m) => m.id === tr.modelId)
		) {
			patchTranslate({ modelId: "" });
		}
	}, [
		showAgent,
		registry,
		availableAgents,
		models,
		tr.agentId,
		tr.modelId,
		patchTranslate,
	]);

	const agentSelectValue = tr.agentId.trim()
		? tr.agentId
		: TRANSLATE_FOLLOW_AGENT;
	const modelSelectValue = tr.modelId.trim()
		? tr.modelId
		: TRANSLATE_FOLLOW_MODEL;

	return (
		<>
			<PageTitle title={t("translate.title")} />
			<SettingsGroup>
				<SettingsRow label={t("translate.provider.label")}>
					<Select
						value={tr.provider}
						onValueChange={(v) =>
							patchTranslate({ provider: v as TranslateProviderId })
						}
						onOpenChange={(open) => {
							if (open) runFreeMtProbe();
						}}
					>
						<SelectTrigger size="sm" className="min-w-[200px] max-w-[280px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent className="max-h-72">
							{providers.map((s) => {
								const freeId = isFreeMtProvider(s.id) ? s.id : null;
								const status: FreeMtProbeStatus | undefined = freeId
									? (probeMap[freeId] ?? "idle")
									: undefined;
								return (
									<SelectItem key={s.id} value={s.id}>
										<span className="flex min-w-0 items-center gap-1.5">
											{status != null ? (
												<ProviderProbeIcon
													status={status}
													labelIdle={t("translate.provider.probeIdle")}
													labelOk={t("translate.provider.probeOk")}
													labelFail={t("translate.provider.probeFail")}
													labelProbing={t("translate.provider.probeProbing")}
												/>
											) : null}
											<span className="truncate">
												{t(
													`translate.provider.${s.nameKey}` as "translate.provider.bing",
												)}
											</span>
										</span>
									</SelectItem>
								);
							})}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("translate.targetLang.label")}>
					<Select
						value={tr.targetLang}
						onValueChange={(v) =>
							patchTranslate({ targetLang: v as TranslateTargetLang })
						}
					>
						<SelectTrigger size="sm" className="min-w-[160px] max-w-[220px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="ui">{t("translate.targetLang.ui")}</SelectItem>
							<SelectItem value="en">{t("translate.targetLang.en")}</SelectItem>
							<SelectItem value="zh-CN">
								{t("translate.targetLang.zhCN")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label={t("translate.autoSelection.label")}
					htmlFor="translate-auto-selection"
				>
					<Switch
						id="translate-auto-selection"
						checked={tr.autoTranslateSelection}
						onCheckedChange={(v) =>
							patchTranslate({ autoTranslateSelection: v })
						}
					/>
				</SettingsRow>
			</SettingsGroup>

			{showAgent && (
				<>
					<SettingsGroup>
						{availableAgents.length === 0 && isTauri() ? (
							<div className="flex flex-col gap-2 px-3.5 py-2.5">
								<p className="text-muted-foreground text-xs leading-relaxed">
									{t("translate.agentId.empty")}
								</p>
								{onOpenAgentSettings && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="w-fit"
										onClick={onOpenAgentSettings}
									>
										{t("translate.agentId.openAgentSettings")}
									</Button>
								)}
							</div>
						) : !isTauri() ? (
							<div className="px-3.5 py-2.5 text-muted-foreground text-xs">
								{t("agent.desktopOnly")}
							</div>
						) : (
							<>
								<SettingsRow label={t("translate.agentId.label")}>
									<Select
										value={agentSelectValue}
										onValueChange={(v) => {
											if (v === TRANSLATE_FOLLOW_AGENT) {
												patchTranslate({ agentId: "", modelId: "" });
											} else {
												patchTranslate({ agentId: v, modelId: "" });
											}
										}}
									>
										<SelectTrigger
											size="sm"
											className="min-w-[200px] max-w-[280px]"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={TRANSLATE_FOLLOW_AGENT}>
												{defaultAgent?.name
													? t("translate.agentId.followDefaultNamed", {
															name: defaultAgent.name,
														})
													: t("translate.agentId.followDefault")}
											</SelectItem>
											{availableAgents.map((a) => (
												<SelectItem key={a.id} value={a.id}>
													{a.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingsRow>
								<SettingsRow label={t("translate.modelId.label")}>
									<Select
										value={modelSelectValue}
										onValueChange={(v) => {
											patchTranslate({
												modelId: v === TRANSLATE_FOLLOW_MODEL ? "" : v,
											});
										}}
									>
										<SelectTrigger
											size="sm"
											className="min-w-[200px] max-w-[280px]"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={TRANSLATE_FOLLOW_MODEL}>
												{t("translate.modelId.followAgent")}
											</SelectItem>
											{models.map((m) => (
												<SelectItem key={m.id} value={m.id}>
													{m.name || m.id}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingsRow>
							</>
						)}
					</SettingsGroup>
					{showAgent && availableAgents.length > 0 && models.length === 0 && (
						<p className="mb-3 px-0.5 text-muted-foreground text-xs leading-relaxed">
							{t("translate.modelId.needWarm")}
						</p>
					)}
				</>
			)}

			{showEndpoint && (
				<>
					<SettingsGroup>
						<div className="flex flex-col gap-1.5 px-3.5 py-2.5">
							<Label
								htmlFor="translate-free-base-url"
								className="font-normal text-[13px]"
							>
								{t("translate.freeBaseUrl.label")}
							</Label>
							<Input
								id="translate-free-base-url"
								value={tr.freeBaseUrl}
								onChange={(e) =>
									patchTranslate({ freeBaseUrl: e.target.value })
								}
								onBlur={() => {
									const trimmed = tr.freeBaseUrl.trim().replace(/\/+$/, "");
									if (trimmed !== tr.freeBaseUrl) {
										patchTranslate({ freeBaseUrl: trimmed });
									}
								}}
								placeholder="https://libretranslate.example"
								className="h-8 font-mono text-xs"
								spellCheck={false}
								autoComplete="off"
							/>
						</div>
					</SettingsGroup>
					<p className="px-0.5 text-muted-foreground text-xs leading-relaxed">
						{t("translate.freeBaseUrl.hint")}
					</p>
				</>
			)}
			<p className="mt-3 px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("translate.footer")}
			</p>
		</>
	);
}

const PDF_ASK_FOLLOW_AGENT = "__pdf_ask_follow_default__";
const PDF_ASK_FOLLOW_MODEL = "__pdf_ask_follow_model__";

function AgentPane({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation(["settings", "agent", "common"]);
	const [catalog, setCatalog] = useState<CatalogScanResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [adding, setAdding] = useState(false);
	const [formName, setFormName] = useState(() => t("agent.form.defaultName"));
	const [formCommand, setFormCommand] = useState("");
	const [formArgs, setFormArgs] = useState("");
	const [proxyEnabled, setProxyEnabled] = useState(false);
	const [proxyUrl, setProxyUrl] = useState("http://127.0.0.1:7890");
	/** Rows currently mid-ACP-probe — drives “探测中” badges. */
	const [probingKeys, setProbingKeys] = useState<Set<string>>(() => new Set());
	const autoProbedRef = useRef(false);

	// PDF Ask agent/model (same listAgents registry as Translate → Agent)
	const [pdfAskRegistry, setPdfAskRegistry] =
		useState<AgentListResponse | null>(null);
	const [pdfAskModels, setPdfAskModels] = useState<
		{ id: string; name: string }[]
	>([]);
	const pdfAsk = settings.pdfAsk;
	const patchPdfAsk = useCallback(
		(partial: Partial<PdfAskSettings>) =>
			patch({ pdfAsk: { ...settings.pdfAsk, ...partial } }),
		[patch, settings.pdfAsk],
	);

	const clearProbingKey = useCallback((key: string) => {
		setProbingKeys((prev) => {
			if (!prev.has(key)) return prev;
			const next = new Set(prev);
			next.delete(key);
			return next;
		});
	}, []);

	/** Scan only — does not toggle busy; callers own the loading flag. */
	const scanOnce =
		useCallback(async (): Promise<CatalogScanResponse | null> => {
			if (!isTauri()) {
				notifyError(t("agent.desktopOnly"));
				return null;
			}
			try {
				const scan = await scanCatalog();
				setCatalog(scan);
				setProxyEnabled(scan.proxyEnabled);
				setProxyUrl(scan.proxyUrl || "http://127.0.0.1:7890");
				return scan;
			} catch (e) {
				notifyError(e instanceof Error ? e.message : String(e));
				return null;
			}
		}, [t]);

	/**
	 * Parallel ACP probe. Soft open skips already-ready rows; force re-probes all
	 * installed. Badge updates from ProbeResult (no per-row full catalog rescan).
	 */
	const probeInstalled = useCallback(
		async (scan: CatalogScanResponse, force: boolean) => {
			if (!isTauri()) return;
			const candidates = scan.entries.filter((e) =>
				catalogNeedsProbe(e, force),
			);
			const custom = scan.customAgents.filter(
				(a) => a.available && (force || a.lastProbeOk !== true),
			);
			if (candidates.length === 0 && custom.length === 0) {
				setProbingKeys(new Set());
				return;
			}

			setProbingKeys(
				new Set([
					...candidates.map((e) => catalogProbeKey(e.templateId)),
					...custom.map((a) => customProbeKey(a.id)),
				]),
			);

			await Promise.allSettled([
				...candidates.map(async (entry) => {
					const key = catalogProbeKey(entry.templateId);
					try {
						const result = await probeCatalogAgent(entry.templateId);
						setCatalog((prev) =>
							prev ? patchCatalogProbe(prev, entry.templateId, result) : prev,
						);
					} catch (e) {
						const err = e instanceof Error ? e.message : String(e);
						setCatalog((prev) =>
							prev
								? patchCatalogProbe(prev, entry.templateId, {
										agentId: entry.registeredId ?? entry.templateId,
										available: false,
										error: err,
									})
								: prev,
						);
					} finally {
						clearProbingKey(key);
					}
				}),
				...custom.map(async (agent) => {
					const key = customProbeKey(agent.id);
					try {
						const result = await probeAgent(agent.id);
						setCatalog((prev) =>
							prev ? patchCustomProbe(prev, agent.id, result) : prev,
						);
					} catch (e) {
						const err = e instanceof Error ? e.message : String(e);
						setCatalog((prev) =>
							prev
								? patchCustomProbe(prev, agent.id, {
										agentId: agent.id,
										available: false,
										error: err,
									})
								: prev,
						);
					} finally {
						clearProbingKey(key);
					}
				}),
			]);
		},
		[clearProbingKey],
	);

	/**
	 * PATH scan → parallel probe → one reconcile scan.
	 * `force`: Refresh / proxy change re-probe everything; open page skips ready.
	 */
	const rescanAndProbe = useCallback(
		async (force = false) => {
			if (!isTauri()) {
				notifyError(t("agent.desktopOnly"));
				return;
			}
			setLoading(true);
			try {
				const scan = await scanOnce();
				if (scan) {
					await probeInstalled(scan, force);
					await scanOnce();
				}
			} finally {
				setLoading(false);
				setProbingKeys(new Set());
			}
		},
		[probeInstalled, scanOnce, t],
	);

	// Open once: soft probe (skip ready). Refresh / proxy use force=true.
	useEffect(() => {
		if (autoProbedRef.current) return;
		autoProbedRef.current = true;
		void rescanAndProbe(false);
	}, [rescanAndProbe]);

	const refreshPdfAskRegistry = useCallback(async () => {
		if (!isTauri()) {
			setPdfAskRegistry(null);
			return;
		}
		try {
			setPdfAskRegistry(await listAgents());
		} catch {
			setPdfAskRegistry(null);
		}
	}, []);

	// Registry for PDF Ask agent/model selects (refresh when catalog changes)
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-load after rescan/probe updates catalog
	useEffect(() => {
		void refreshPdfAskRegistry();
	}, [catalog, refreshPdfAskRegistry]);

	const pdfAskAvailable = listAvailableAgents(pdfAskRegistry);
	const pdfAskDefault = pdfAskRegistry?.defaultId
		? (pdfAskAvailable.find((a) => a.id === pdfAskRegistry.defaultId) ??
			pdfAskRegistry.agents.find((a) => a.id === pdfAskRegistry.defaultId))
		: undefined;
	const pdfAskResolvedAgentId =
		pdfAsk.agentId.trim() || pdfAskRegistry?.defaultId || "";

	useEffect(() => {
		if (!pdfAskResolvedAgentId) {
			setPdfAskModels([]);
			return;
		}
		const cached = loadModelCatalog(pdfAskResolvedAgentId);
		setPdfAskModels(cached?.models ?? []);
		if (!isTauri()) return;
		let cancelled = false;
		void warmAgent({ agentId: pdfAskResolvedAgentId }).catch(() => undefined);
		const tmr = window.setTimeout(() => {
			if (cancelled) return;
			const next = loadModelCatalog(pdfAskResolvedAgentId);
			if (next?.models?.length) setPdfAskModels(next.models);
		}, 800);
		return () => {
			cancelled = true;
			window.clearTimeout(tmr);
		};
	}, [pdfAskResolvedAgentId]);

	useEffect(() => {
		if (!pdfAskRegistry) return;
		if (
			pdfAsk.agentId &&
			!pdfAskAvailable.some((a) => a.id === pdfAsk.agentId)
		) {
			patchPdfAsk({ agentId: "", modelId: "" });
			return;
		}
		if (
			pdfAsk.modelId &&
			pdfAskModels.length > 0 &&
			!pdfAskModels.some((m) => m.id === pdfAsk.modelId)
		) {
			patchPdfAsk({ modelId: "" });
		}
	}, [
		pdfAskRegistry,
		pdfAskAvailable,
		pdfAskModels,
		pdfAsk.agentId,
		pdfAsk.modelId,
		patchPdfAsk,
	]);

	const pdfAskAgentSelect = pdfAsk.agentId.trim()
		? pdfAsk.agentId
		: PDF_ASK_FOLLOW_AGENT;
	const pdfAskModelSelect = pdfAsk.modelId.trim()
		? pdfAsk.modelId
		: PDF_ASK_FOLLOW_MODEL;

	const onToggleEnabled = async (v: boolean) => {
		patch({ agentEnabled: v });
		if (!isTauri()) return;
		setLoading(true);
		try {
			await setAgentEnabled(v);
			await scanOnce();
		} catch (e) {
			notifyError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	/**
	 * Persist proxy then force re-probe (host clears last_probe_* on change).
	 * Proxy switch stays enabled during the batch.
	 */
	const saveProxySettings = async (enabled: boolean, url: string) => {
		if (!isTauri()) return;
		setLoading(true);
		try {
			const saved = await setAgentProxy(enabled, url);
			setProxyEnabled(saved.proxyEnabled);
			setProxyUrl(saved.proxyUrl || "http://127.0.0.1:7890");
			const scan = await scanOnce();
			if (scan) {
				await probeInstalled(scan, true);
				await scanOnce();
			}
		} catch (e) {
			notifyError(e instanceof Error ? e.message : String(e));
			await scanOnce();
		} finally {
			setLoading(false);
			setProbingKeys(new Set());
		}
	};

	const onToggleProxy = async (v: boolean) => {
		setProxyEnabled(v);
		await saveProxySettings(v, proxyUrl);
	};

	const onCommitProxyUrl = async () => {
		await saveProxySettings(proxyEnabled, proxyUrl);
	};

	const onRescanAndProbe = async () => {
		await rescanAndProbe(true);
	};

	const onUseDefault = async (entry: CatalogEntry) => {
		if (!isTauri()) return;
		setLoading(true);
		try {
			await ensureCatalogAgent(entry.templateId, true);
			await scanOnce();
		} catch (e) {
			notifyError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	const onInstallAdapter = async (entry: CatalogEntry) => {
		if (!isTauri()) return;
		try {
			await openInstallTerminal(entry.templateId);
		} catch (e) {
			notifyError(e instanceof Error ? e.message : String(e));
		}
	};

	const onRemove = async (id: string) => {
		if (!isTauri()) return;
		setLoading(true);
		try {
			await removeAgent(id);
			await scanOnce();
		} catch (e) {
			notifyError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	const onAddCustom = async () => {
		if (!isTauri()) return;
		setLoading(true);
		try {
			const args = formArgs.trim().split(/\s+/).filter(Boolean);
			await upsertAgent({
				name: formName.trim() || formCommand,
				template: "custom" as AgentTemplate,
				command: formCommand.trim(),
				args,
				setDefault: true,
			});
			setAdding(false);
			setFormCommand("");
			setFormArgs("");
			const scan = await scanOnce();
			if (scan) {
				await probeInstalled(scan, true);
				await scanOnce();
			}
		} catch (e) {
			notifyError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
			setProbingKeys(new Set());
		}
	};

	const entries = catalog?.entries ?? [];
	const customAgents = catalog?.customAgents ?? [];
	const busy = loading;

	return (
		<>
			<PageTitle title={t("agent.title")} />
			<SettingsGroup>
				<SettingsRow label={t("agent.enable.label")} htmlFor="agent-enabled">
					<Switch
						id="agent-enabled"
						checked={settings.agentEnabled}
						onCheckedChange={(v) => void onToggleEnabled(v)}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("agent.proxy.label")}
					htmlFor="agent-proxy-enabled"
				>
					<div className="flex items-center gap-2">
						<Input
							value={proxyUrl}
							onChange={(e) => setProxyUrl(e.target.value)}
							onBlur={() => void onCommitProxyUrl()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.currentTarget.blur();
								}
							}}
							placeholder="http://127.0.0.1:7890"
							spellCheck={false}
							autoComplete="off"
							disabled={!proxyEnabled || !isTauri()}
							className="h-8 w-48 text-xs"
						/>
						<Switch
							id="agent-proxy-enabled"
							checked={proxyEnabled}
							disabled={!isTauri()}
							onCheckedChange={(v) => void onToggleProxy(v)}
						/>
					</div>
				</SettingsRow>
				<SettingsRow label={t("agent.permission.label")} htmlFor="agent-perm">
					<Select
						value={settings.agentPermissionMode}
						onValueChange={(v) =>
							patch({ agentPermissionMode: v as AgentPermissionMode })
						}
					>
						<SelectTrigger id="agent-perm" size="sm" className="min-w-[140px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="restricted">
								{t("agent.permission.restricted.label")}
							</SelectItem>
							<SelectItem value="ask">
								{t("agent.permission.ask.label")}
							</SelectItem>
							<SelectItem value="auto">
								{t("agent.permission.auto.label")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label={t("agent.autoPaperReader.label")}
					htmlFor="agent-auto-paper-reader"
					description={t("agent.autoPaperReader.hint")}
				>
					<Switch
						id="agent-auto-paper-reader"
						checked={settings.autoPaperReader}
						onCheckedChange={(v) => patch({ autoPaperReader: v })}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("agent.responseLanguage.label")}
					htmlFor="agent-response-language"
				>
					<Select
						value={settings.aiResponseLanguage}
						onValueChange={(v) =>
							patch({ aiResponseLanguage: v as AiResponseLanguage })
						}
					>
						<SelectTrigger
							id="agent-response-language"
							size="sm"
							className="min-w-[140px]"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="auto">
								{t("agent.responseLanguage.auto")}
							</SelectItem>
							<SelectItem value="en">
								{t("agent.responseLanguage.en")}
							</SelectItem>
							<SelectItem value="zh-CN">
								{t("agent.responseLanguage.zhCN")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup>
				<div className="flex flex-col gap-1.5 px-3.5 py-2.5">
					<Label
						htmlFor="agent-personal-prompt"
						className="font-normal text-[13px]"
					>
						{t("agent.personalPrompt.label")}
					</Label>
					<p className="text-muted-foreground text-xs leading-relaxed">
						{t("agent.personalPrompt.hint")}
					</p>
					<Textarea
						id="agent-personal-prompt"
						value={settings.agentPersonalPrompt}
						onChange={(e) =>
							patch({
								agentPersonalPrompt: e.target.value.slice(0, 8000),
							})
						}
						onBlur={() => {
							const trimmed = settings.agentPersonalPrompt.trim();
							if (trimmed !== settings.agentPersonalPrompt) {
								patch({ agentPersonalPrompt: trimmed });
							}
						}}
						placeholder={t("agent.personalPrompt.placeholder")}
						rows={4}
						className="min-h-[88px] resize-y text-xs"
						spellCheck={true}
					/>
				</div>
			</SettingsGroup>

			<p className="mb-1.5 mt-4 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{t("agent.pdfAsk.section")}
			</p>
			<p className="mb-2 px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("agent.pdfAsk.hint")}
			</p>
			<SettingsGroup>
				{pdfAskAvailable.length === 0 ? (
					<p className="px-3 py-2 text-muted-foreground text-xs">
						{t("agent.pdfAsk.agentId.empty")}
					</p>
				) : (
					<>
						<SettingsRow label={t("agent.pdfAsk.agentId.label")}>
							<Select
								value={pdfAskAgentSelect}
								onValueChange={(v) => {
									if (v === PDF_ASK_FOLLOW_AGENT) {
										patchPdfAsk({ agentId: "", modelId: "" });
									} else {
										patchPdfAsk({ agentId: v, modelId: "" });
									}
								}}
							>
								<SelectTrigger
									size="sm"
									className="min-w-[200px] max-w-[280px]"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={PDF_ASK_FOLLOW_AGENT}>
										{pdfAskDefault?.name
											? t("agent.pdfAsk.agentId.followDefaultNamed", {
													name: pdfAskDefault.name,
												})
											: t("agent.pdfAsk.agentId.followDefault")}
									</SelectItem>
									{pdfAskAvailable.map((a) => (
										<SelectItem key={a.id} value={a.id}>
											{a.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SettingsRow>
						<SettingsRow label={t("agent.pdfAsk.modelId.label")}>
							<Select
								value={pdfAskModelSelect}
								onValueChange={(v) => {
									patchPdfAsk({
										modelId: v === PDF_ASK_FOLLOW_MODEL ? "" : v,
									});
								}}
							>
								<SelectTrigger
									size="sm"
									className="min-w-[200px] max-w-[280px]"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={PDF_ASK_FOLLOW_MODEL}>
										{t("agent.pdfAsk.modelId.followAgent")}
									</SelectItem>
									{pdfAskModels.map((m) => (
										<SelectItem key={m.id} value={m.id}>
											{m.name || m.id}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SettingsRow>
					</>
				)}
			</SettingsGroup>

			{!isTauri() ? (
				<p className="mb-3 text-muted-foreground text-xs">
					{t("agent.desktopHint")}
				</p>
			) : null}

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
					onClick={() => void onRescanAndProbe()}
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
				{entries.length === 0 && busy ? (
					<div className="flex items-center gap-2 px-3.5 py-4 text-muted-foreground text-xs">
						<Loader2 className="size-3.5 animate-spin" aria-hidden />
						{t("agent.scanning")}
					</div>
				) : null}
				{entries.map((entry) => {
					const canUse =
						entry.binaryAvailable ||
						entry.acpCommandAvailable ||
						entry.acpStatus === "ready";
					const showInstall = Boolean(entry.offerInstall);
					const notInstalled = !entry.binaryAvailable;
					// Mid-probe or host-cleared not-probed while a batch is running.
					const isProbing =
						probingKeys.has(catalogProbeKey(entry.templateId)) ||
						(entry.acpStatus === "not-probed" &&
							(loading || probingKeys.size > 0));
					return (
						<div
							key={entry.templateId}
							className={cn(
								"flex items-center justify-between gap-3 border-b py-2.5 pr-1.5 pl-3.5 last:border-b-0",
								notInstalled && "opacity-50",
							)}
						>
							<div className="flex min-w-0 flex-1 items-center gap-4">
								<span
									className={cn(
										"w-24 shrink-0 truncate font-medium text-[13px]",
										notInstalled && "text-muted-foreground",
									)}
								>
									{entry.name}
								</span>
								<div className="flex min-w-0 flex-wrap items-center gap-1.5">
									{entry.binaryAvailable ? (
										<StatusBadge tone="ok">
											{t("agent.badges.installed")}
										</StatusBadge>
									) : (
										<StatusBadge tone="muted">
											{t("agent.badges.notInstalled")}
										</StatusBadge>
									)}
									{isProbing ? (
										<ProbingBadge label={t("agent.probing")} />
									) : entry.acpStatus !== "missing" ? (
										<StatusBadge tone={catalogStatusTone(entry.acpStatus)}>
											{acpStatusLabel(entry.acpStatus)}
										</StatusBadge>
									) : null}
									{showInstall ? (
										<StatusBadge tone="warn">
											{t("agent.badges.adapterMissing")}
										</StatusBadge>
									) : null}
								</div>
							</div>
							{/* Fixed action slot so icon-only rows align with “Use default” */}
							<div
								className={cn(
									"flex h-7 shrink-0 items-center justify-center gap-1",
									showInstall ? "min-w-0" : "w-20",
								)}
							>
								{showInstall ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="h-7 gap-1 px-2 text-xs"
										aria-label={t("agent.installAdapterAria", {
											name: entry.name,
										})}
										title={
											entry.installCommand
												? t("agent.installAdapterTitle", {
														command: entry.installCommand,
													})
												: t("agent.installAdapter")
										}
										disabled={busy || !isTauri()}
										onClick={() => void onInstallAdapter(entry)}
									>
										<Terminal className="size-3" />
										{t("agent.installAdapter")}
									</Button>
								) : null}
								{entry.isDefault ? (
									<span
										className="flex size-7 items-center justify-center text-primary"
										title={t("agent.badges.default")}
										role="img"
										aria-label={t("agent.badges.default")}
									>
										<Check className="size-4" aria-hidden />
									</span>
								) : canUse && !showInstall ? (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="h-7 shrink-0 px-2 text-xs"
										onClick={() => void onUseDefault(entry)}
									>
										{t("agent.useDefault")}
									</Button>
								) : null}
							</div>
						</div>
					);
				})}
				{customAgents.map((agent) => {
					const isDefault = catalog?.defaultId === agent.id;
					const notProbedYet = agent.available && agent.lastProbeOk == null;
					const isProbing =
						probingKeys.has(customProbeKey(agent.id)) ||
						(notProbedYet && (loading || probingKeys.size > 0));
					return (
						<div
							key={agent.id}
							className="flex items-center justify-between gap-3 border-b py-2.5 pr-1.5 pl-3.5 last:border-b-0"
						>
							<div className="flex min-w-0 flex-1 items-center gap-4">
								<span className="w-24 shrink-0 truncate font-medium text-[13px]">
									{agent.name}
								</span>
								<div className="flex min-w-0 flex-wrap items-center gap-1.5">
									{isDefault ? (
										<StatusBadge tone="primary">
											{t("agent.badges.default")}
										</StatusBadge>
									) : null}
									{isProbing ? (
										<ProbingBadge label={t("agent.probing")} />
									) : agent.lastProbeOk === true ? (
										<StatusBadge tone="ok">
											{t("agent:acpStatus.ready")}
										</StatusBadge>
									) : agent.lastProbeOk === false ? (
										<StatusBadge tone="err">
											{t("agent:acpStatus.failed")}
										</StatusBadge>
									) : notProbedYet ? (
										<ProbingBadge label={t("agent.probing")} />
									) : (
										<StatusBadge tone="muted">
											{t("agent:acpStatus.notInstalled")}
										</StatusBadge>
									)}
								</div>
							</div>
							<div className="flex h-7 w-20 shrink-0 items-center justify-center gap-1">
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="size-7"
									aria-label={t("common:remove")}
									onClick={() => void onRemove(agent.id)}
								>
									<Trash2 className="size-3.5" />
								</Button>
							</div>
						</div>
					);
				})}
				{/* Custom entry row — same row style as catalog agents; + expands the form */}
				<div className="flex items-center justify-between gap-3 border-b py-2.5 pr-1.5 pl-3.5 last:border-b-0">
					<div className="flex min-w-0 flex-1 items-center gap-4">
						<span className="w-24 shrink-0 truncate font-medium text-[13px]">
							{t("agent.custom")}
						</span>
					</div>
					<div className="flex h-7 w-20 shrink-0 items-center justify-center gap-1">
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="size-7"
							disabled={!isTauri()}
							aria-label={adding ? t("common:cancel") : t("agent.addCustom")}
							title={adding ? t("common:cancel") : t("agent.addCustom")}
							onClick={() => setAdding((v) => !v)}
						>
							{adding ? (
								<X className="size-3.5" aria-hidden />
							) : (
								<Plus className="size-3.5" aria-hidden />
							)}
						</Button>
					</div>
				</div>
				{adding ? (
					<div className="space-y-2.5 border-b px-3.5 py-3 last:border-b-0">
						<div className="space-y-1">
							<Label className="font-normal text-[13px]">
								{t("agent.form.name")}
							</Label>
							<Input
								value={formName}
								onChange={(e) => setFormName(e.target.value)}
								spellCheck={false}
							/>
						</div>
						<div className="space-y-1">
							<Label className="font-normal text-[13px]">
								{t("agent.form.command")}
							</Label>
							<Input
								value={formCommand}
								onChange={(e) => setFormCommand(e.target.value)}
								placeholder="opencode"
								spellCheck={false}
								autoComplete="off"
							/>
						</div>
						<div className="space-y-1">
							<Label className="font-normal text-[13px]">
								{t("agent.form.args")}
							</Label>
							<Input
								value={formArgs}
								onChange={(e) => setFormArgs(e.target.value)}
								placeholder="acp"
								spellCheck={false}
								autoComplete="off"
							/>
						</div>
						<div className="flex justify-end gap-1.5 pt-1">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => setAdding(false)}
							>
								{t("common:cancel")}
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={!formCommand.trim() || loading}
								onClick={() => void onAddCustom()}
							>
								{t("common:save")}
							</Button>
						</div>
					</div>
				) : null}
			</SettingsGroup>
			<p className="mt-2 mb-3 px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("agent.commonAgentsHint")}
			</p>
		</>
	);
}

/**
 * Agent settings when the active vault is remote: discover + ACP probe run on the
 * SSH host (not this machine). App-level prefs (permission, language) still apply.
 */
function RemoteAgentPane({
	settings,
	patch,
	hostContext,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	hostContext: Extract<SettingsHostContext, { kind: "remote" }>;
}) {
	const { t } = useTranslation(["settings", "agent", "common"]);
	const [entries, setEntries] = useState<CatalogEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [probingKeys, setProbingKeys] = useState<Set<string>>(() => new Set());
	const [proxyEnabled, setProxyEnabled] = useState(false);
	const [proxyUrl, setProxyUrl] = useState("http://127.0.0.1:7890");
	const sessionId = hostContext.sessionId;

	const clearProbingKey = useCallback((key: string) => {
		setProbingKeys((prev) => {
			if (!prev.has(key)) return prev;
			const next = new Set(prev);
			next.delete(key);
			return next;
		});
	}, []);

	// Same registry proxy as local Agent settings (injected into remote process env).
	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		void scanCatalog()
			.then((scan) => {
				if (cancelled) return;
				setProxyEnabled(scan.proxyEnabled);
				setProxyUrl(scan.proxyUrl || "http://127.0.0.1:7890");
			})
			.catch(() => {
				/* ignore */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const scanOnce = useCallback(async (): Promise<CatalogEntry[] | null> => {
		if (!isTauri()) {
			notifyError(t("agent.desktopOnly"));
			return null;
		}
		try {
			const scan = await remoteAgentScan(sessionId);
			setEntries(scan.entries);
			return scan.entries;
		} catch (e) {
			notifyError(e instanceof Error ? e.message : String(e));
			return null;
		}
	}, [sessionId, t]);

	const patchEntryProbe = useCallback(
		(templateId: string, result: ProbeResult) => {
			setEntries((prev) =>
				prev.map((entry) => {
					if (entry.templateId !== templateId) return entry;
					return {
						...entry,
						acpStatus: result.available ? "ready" : "failed",
						acpAgentName: result.agentName ?? null,
						lastProbeError: result.error ?? null,
						lastProbedAt: new Date().toISOString(),
					};
				}),
			);
		},
		[],
	);

	const probeInstalled = useCallback(
		async (list: CatalogEntry[], force: boolean) => {
			if (!isTauri()) return;
			const candidates = list.filter((e) => catalogNeedsProbe(e, force));
			if (candidates.length === 0) {
				setProbingKeys(new Set());
				return;
			}
			setProbingKeys(
				new Set(candidates.map((e) => catalogProbeKey(e.templateId))),
			);
			await Promise.allSettled(
				candidates.map(async (entry) => {
					const key = catalogProbeKey(entry.templateId);
					try {
						const result = await remoteAgentProbe(sessionId, entry.templateId);
						patchEntryProbe(entry.templateId, result);
					} catch (e) {
						const err = e instanceof Error ? e.message : String(e);
						patchEntryProbe(entry.templateId, {
							agentId: entry.templateId,
							available: false,
							error: err,
						});
					} finally {
						clearProbingKey(key);
					}
				}),
			);
		},
		[sessionId, patchEntryProbe, clearProbingKey],
	);

	const rescanAndProbe = useCallback(
		async (force = false) => {
			if (!isTauri()) {
				notifyError(t("agent.desktopOnly"));
				return;
			}
			setLoading(true);
			try {
				const list = await scanOnce();
				if (list) await probeInstalled(list, force);
			} finally {
				setLoading(false);
				setProbingKeys(new Set());
			}
		},
		[probeInstalled, scanOnce, t],
	);

	// Soft probe when remote session (or rescan callback) changes.
	useEffect(() => {
		void rescanAndProbe(false);
	}, [rescanAndProbe]);

	const saveProxySettings = async (enabled: boolean, url: string) => {
		if (!isTauri()) return;
		setLoading(true);
		try {
			const saved = await setAgentProxy(enabled, url);
			setProxyEnabled(saved.proxyEnabled);
			setProxyUrl(saved.proxyUrl || "http://127.0.0.1:7890");
			// Proxy is injected into remote agent env — re-probe after change.
			await rescanAndProbe(true);
		} catch (e) {
			notifyError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	const onToggleProxy = async (v: boolean) => {
		setProxyEnabled(v);
		await saveProxySettings(v, proxyUrl);
	};

	const onCommitProxyUrl = async () => {
		await saveProxySettings(proxyEnabled, proxyUrl);
	};

	const onInstallAdapter = async (entry: CatalogEntry) => {
		if (!isTauri()) return;
		try {
			await remoteAgentOpenInstallTerminal(sessionId, entry.templateId);
		} catch (e) {
			notifyError(e instanceof Error ? e.message : String(e));
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
				<SettingsRow
					label={t("agent.proxy.label")}
					htmlFor="agent-proxy-enabled-r"
				>
					<div className="flex items-center gap-2">
						<Input
							value={proxyUrl}
							onChange={(e) => setProxyUrl(e.target.value)}
							onBlur={() => void onCommitProxyUrl()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.currentTarget.blur();
								}
							}}
							placeholder="http://127.0.0.1:7890"
							spellCheck={false}
							autoComplete="off"
							disabled={!proxyEnabled || !isTauri()}
							className="h-8 w-48 text-xs"
						/>
						<Switch
							id="agent-proxy-enabled-r"
							checked={proxyEnabled}
							disabled={!isTauri()}
							onCheckedChange={(v) => void onToggleProxy(v)}
						/>
					</div>
				</SettingsRow>
				<p className="border-b px-3.5 py-2 text-muted-foreground text-[11px] leading-relaxed last:border-b-0">
					{t("agent.remote.proxyHint")}
				</p>
				<SettingsRow label={t("agent.permission.label")} htmlFor="agent-perm-r">
					<Select
						value={settings.agentPermissionMode}
						onValueChange={(v) =>
							patch({ agentPermissionMode: v as AgentPermissionMode })
						}
					>
						<SelectTrigger
							id="agent-perm-r"
							size="sm"
							className="min-w-[140px]"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="restricted">
								{t("agent.permission.restricted.label")}
							</SelectItem>
							<SelectItem value="ask">
								{t("agent.permission.ask.label")}
							</SelectItem>
							<SelectItem value="auto">
								{t("agent.permission.auto.label")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label={t("agent.autoPaperReader.label")}
					htmlFor="agent-auto-paper-reader-r"
					description={t("agent.autoPaperReader.hint")}
				>
					<Switch
						id="agent-auto-paper-reader-r"
						checked={settings.autoPaperReader}
						onCheckedChange={(v) => patch({ autoPaperReader: v })}
					/>
				</SettingsRow>
				<SettingsRow
					label={t("agent.responseLanguage.label")}
					htmlFor="agent-response-language-r"
				>
					<Select
						value={settings.aiResponseLanguage}
						onValueChange={(v) =>
							patch({ aiResponseLanguage: v as AiResponseLanguage })
						}
					>
						<SelectTrigger
							id="agent-response-language-r"
							size="sm"
							className="min-w-[140px]"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="auto">
								{t("agent.responseLanguage.auto")}
							</SelectItem>
							<SelectItem value="en">
								{t("agent.responseLanguage.en")}
							</SelectItem>
							<SelectItem value="zh-CN">
								{t("agent.responseLanguage.zhCN")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
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
				{entries.map((entry) => {
					const showInstall = Boolean(entry.offerInstall);
					const notInstalled =
						!entry.binaryAvailable && !entry.acpCommandAvailable;
					const isProbing =
						probingKeys.has(catalogProbeKey(entry.templateId)) ||
						(entry.acpStatus === "not-probed" &&
							(loading || probingKeys.size > 0) &&
							(entry.binaryAvailable || entry.acpCommandAvailable));
					return (
						<div
							key={entry.templateId}
							className={cn(
								"flex items-center justify-between gap-3 border-b py-2.5 pr-1.5 pl-3.5 last:border-b-0",
								notInstalled && "opacity-50",
							)}
						>
							<div className="flex min-w-0 flex-1 items-center gap-4">
								<span
									className={cn(
										"w-24 shrink-0 truncate font-medium text-[13px]",
										notInstalled && "text-muted-foreground",
									)}
									title={
										entry.lastProbeError || entry.description || entry.name
									}
								>
									{entry.name}
								</span>
								<div className="flex min-w-0 flex-wrap items-center gap-1.5">
									{entry.binaryAvailable ? (
										<StatusBadge tone="ok">
											{t("agent.badges.installed")}
										</StatusBadge>
									) : (
										<StatusBadge tone="muted">
											{t("agent.badges.notInstalled")}
										</StatusBadge>
									)}
									{isProbing ? (
										<ProbingBadge label={t("agent.probing")} />
									) : entry.acpStatus !== "missing" ? (
										<StatusBadge
											tone={catalogStatusTone(entry.acpStatus)}
											title={
												entry.lastProbeError ?? entry.acpAgentName ?? undefined
											}
										>
											{acpStatusLabel(entry.acpStatus)}
										</StatusBadge>
									) : null}
									{showInstall ? (
										<StatusBadge tone="warn">
											{t("agent.badges.adapterMissing")}
										</StatusBadge>
									) : null}
								</div>
							</div>
							<div
								className={cn(
									"flex h-7 shrink-0 items-center justify-center gap-1",
									showInstall ? "min-w-0" : "w-8",
								)}
							>
								{showInstall ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="h-7 gap-1 px-2 text-xs"
										aria-label={t("agent.remote.installAdapterAria", {
											name: entry.name,
										})}
										title={
											entry.installCommand
												? t("agent.remote.installAdapterTitle", {
														command: entry.installCommand,
														host: hostContext.label,
													})
												: t("agent.installAdapter")
										}
										disabled={busy || !isTauri()}
										onClick={() => void onInstallAdapter(entry)}
									>
										<Terminal className="size-3" />
										{t("agent.installAdapter")}
									</Button>
								) : null}
							</div>
						</div>
					);
				})}
			</SettingsGroup>
			<p className="mt-2 mb-3 px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("agent.remote.hint")}
			</p>
		</>
	);
}

function KeyboardPane() {
	const { t } = useTranslation(["settings", "shortcuts"]);
	const groups = shortcutsByGroup();

	return (
		<>
			<PageTitle title={t("keyboard.title")} />
			{groups.map(({ group, items }) => (
				<div key={group} className="mb-5">
					<p className="mb-1.5 px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
						{t(`shortcuts:groups.${GROUP_KEY[group]}`)}
					</p>
					<SettingsGroup>
						{items.map((item) => (
							<ShortcutRow key={item.id} def={item} />
						))}
					</SettingsGroup>
				</div>
			))}
		</>
	);
}

function ShortcutRow({ def }: { def: ShortcutDef }) {
	const { t } = useTranslation(["shortcuts", "sidebar"]);
	// "Show in Finder" is macOS wording; use the platform-specific file-manager name.
	const label =
		def.id === "revealInFinder"
			? t(`sidebar:${revealInOsLabelKey()}`)
			: t(`labels.${def.id}`);
	return (
		<div className="flex items-center justify-between gap-4 border-b px-3.5 py-2.5 last:border-b-0">
			<span className="text-[13px]">{label}</span>
			<kbd className="rounded-md border bg-muted/60 px-1.5 py-0.5 font-medium font-sans text-[12px] text-foreground tracking-wide">
				{formatShortcut(def)}
			</kbd>
		</div>
	);
}

function PrivacyPane({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<>
			<PageTitle title={t("privacy.title")} />
			<SettingsGroup>
				<SettingsRow label={t("privacy.analytics.label")} htmlFor="analytics">
					<Switch
						id="analytics"
						checked={settings.analyticsEnabled}
						onCheckedChange={(v) => patch({ analyticsEnabled: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("privacy.crash.label")} htmlFor="crash">
					<Switch
						id="crash"
						checked={settings.shareCrashReports}
						onCheckedChange={(v) => patch({ shareCrashReports: v })}
					/>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}

function AboutPane() {
	const { t } = useTranslation("settings");
	return (
		<>
			<PageTitle title={t("about.title")} />
			<SettingsGroup>
				<div className="space-y-1 px-3.5 py-4 text-center">
					<p className="font-semibold text-base tracking-tight">Agentero</p>
					<p className="text-muted-foreground text-sm">
						{t("about.version", { version: "0.1.0" })}
					</p>
					<p className="pt-2 text-muted-foreground text-xs leading-relaxed">
						{t("about.tagline")}
					</p>
				</div>
			</SettingsGroup>
		</>
	);
}
