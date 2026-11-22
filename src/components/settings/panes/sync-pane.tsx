import {
	ArrowDownToLine,
	ArrowUpFromLine,
	ChevronRight,
	CloudUpload,
	LoaderCircle,
	Plus,
	Trash2,
	TriangleAlert,
	Unplug,
	X,
} from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaAws } from "react-icons/fa6";
import {
	SiAlibabacloud,
	SiBaidu,
	SiCloudflare,
	SiGithub,
	SiGitlab,
	SiMinio,
	SiNextcloud,
} from "react-icons/si";
import { JianguoyunIcon } from "@/components/icons/jianguoyun-icon";
import {
	CloudUsageLine,
	useCloudUsage,
} from "@/components/settings/cloud-usage";
import {
	HelpLabel,
	PageTitle,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import { authClient } from "@/features/account/client";
import { formatLocaleTimestamp } from "@/i18n";
import { formatBytes } from "@/lib/core/background-tasks";
import { events } from "@/lib/core/bindings";
import type { ApiError } from "@/lib/core/ipc";
import { errorMessage, notifyError, notifySuccess } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { displayPath } from "@/lib/core/path";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { isTauri } from "@/lib/core/tauri";
import { toSafeDisposer } from "@/lib/core/tauri-events";
import { cn } from "@/lib/core/utils";
import {
	emptySyncConfig,
	isSyncMirrorPhase,
	isSyncProgressPhase,
	SYNC_INTERVAL_CHOICES,
	type SyncBackendConfig,
	type SyncMirrorStatus,
	type SyncOverwriteDirection,
	type SyncOverwritePreview,
	type SyncProgressEvent,
	type SyncScopeSizes,
	type SyncStateEvent,
	type SyncStatus,
	syncConfigure,
	syncDisconnect,
	syncGetStatus,
	syncNow,
	syncOverwrite,
	syncOverwritePreview,
	syncScopeSizes,
} from "@/lib/sync/api";
import { vaultDisplayName } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { getRecentVaults } from "@/lib/vault/session";

type SyncProviderLink = {
	id: string;
	name: string;
	docsUrl: string;
	icon: ComponentType<{ className?: string }>;
	iconClassName: string;
};

const SYNC_PROVIDER_LINKS: SyncProviderLink[] = [
	{
		id: "aws",
		name: "AWS S3",
		docsUrl:
			"https://docs.aws.amazon.com/AmazonS3/latest/userguide/GetStartedWithS3.html",
		icon: FaAws,
		iconClassName: "text-[#FF9900]",
	},
	{
		id: "cloudflare-r2",
		name: "Cloudflare R2",
		docsUrl: "https://developers.cloudflare.com/r2/get-started/s3/",
		icon: SiCloudflare,
		iconClassName: "text-[#F38020]",
	},
	{
		id: "minio",
		name: "MinIO",
		docsUrl:
			"https://docs.min.io/aistor/administration/console/security-and-access/",
		icon: SiMinio,
		iconClassName: "text-[#C72E49]",
	},
	{
		id: "alibaba-oss",
		name: "Alibaba Cloud OSS",
		docsUrl:
			"https://www.alibabacloud.com/help/en/oss/developer-reference/use-aws-sdks-to-access-oss",
		icon: SiAlibabacloud,
		iconClassName: "text-[#FF6A00]",
	},
	{
		id: "baidu-bos",
		name: "Baidu BOS",
		docsUrl: "https://cloud.baidu.com/doc/BOS/s/ojwvyq973",
		icon: SiBaidu,
		iconClassName: "text-[#2932E1]",
	},
];

const WEBDAV_PROVIDER_LINKS: SyncProviderLink[] = [
	{
		id: "jianguoyun",
		name: "Jianguoyun",
		docsUrl: "https://help.jianguoyun.com/?p=2064",
		icon: JianguoyunIcon,
		iconClassName: "text-[#C7792B]",
	},
	{
		id: "nextcloud",
		name: "Nextcloud",
		docsUrl:
			"https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html",
		icon: SiNextcloud,
		iconClassName: "text-[#0082C9]",
	},
];

const GIT_PROVIDER_LINKS: SyncProviderLink[] = [
	{
		id: "github",
		name: "GitHub",
		docsUrl:
			"https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository",
		icon: SiGithub,
		iconClassName: "text-foreground",
	},
	{
		id: "gitlab",
		name: "GitLab",
		docsUrl: "https://docs.gitlab.com/ee/user/project/repository/",
		icon: SiGitlab,
		iconClassName: "text-[#FC6D26]",
	},
];

const BACKEND_OPTIONS = [
	{ value: "agentero", labelKey: "sync.backendAgentero" },
	{ value: "s3", labelKey: "sync.backendS3" },
	{ value: "webdav", labelKey: "sync.backendWebdav" },
	{ value: "git", labelKey: "sync.backendGit" },
] as const;

/** Dismissing the conditional-writes notice is a permanent, device-local choice. */
const DEGRADED_NOTICE_DISMISSED_KEY =
	"agentero.sync.degradedNoticeDismissed.v1";

/** Local Vaults this pane can edit: the opener plus the shared MRU list. */
function localVaultChoices(primary: string | null): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const candidate of [primary, ...getRecentVaults()]) {
		if (!candidate || isRemoteVaultHandle(candidate)) continue;
		const key = candidate.replace(/[\\/]+$/, "");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(candidate);
	}
	return out;
}

export function SyncPane({ vaultPath }: { vaultPath: string | null }) {
	const [vaults, setVaults] = useState(() => localVaultChoices(vaultPath));
	const [selectedVault, setSelectedVault] = useState<string | null>(
		() => localVaultChoices(vaultPath)[0] ?? null,
	);

	useEffect(() => {
		const choices = localVaultChoices(vaultPath);
		setVaults(choices);
		setSelectedVault((prev) => {
			if (vaultPath && choices.includes(vaultPath)) return vaultPath;
			if (prev && choices.includes(prev)) return prev;
			return choices[0] ?? null;
		});
	}, [vaultPath]);

	useEffect(() => {
		const onStorage = () => setVaults(localVaultChoices(vaultPath));
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [vaultPath]);

	const localVault =
		isTauri() && selectedVault && !isRemoteVaultHandle(selectedVault)
			? selectedVault
			: null;
	return (
		<VaultSyncForm
			key={localVault}
			localVault={localVault}
			vaults={vaults}
			setSelectedVault={setSelectedVault}
		/>
	);
}

function VaultSyncForm({
	localVault,
	vaults,
	setSelectedVault,
}: {
	localVault: string | null;
	vaults: string[];
	setSelectedVault: (vault: string | null) => void;
}) {
	const { t } = useTranslation("settings");
	const formVersion = useRef(0);
	const requestId = useRef(0);

	const [status, setStatus] = useState<SyncStatus | null>(null);
	const [form, setForm] = useState<SyncBackendConfig>(emptySyncConfig());
	const [saving, setSaving] = useState(false);
	const [syncing, setSyncing] = useState(false);
	const [progress, setProgress] = useState<SyncProgressEvent | null>(null);
	const [syncError, setSyncError] = useState<string | null>(null);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [degradedNoticeDismissed, setDegradedNoticeDismissed] = useState(() =>
		readJsonStorage<boolean>(DEGRADED_NOTICE_DISMISSED_KEY, false),
	);
	const [overwriteDialog, setOverwriteDialog] = useState<{
		direction: SyncOverwriteDirection;
		preview: SyncOverwritePreview;
	} | null>(null);
	const [overwriting, setOverwriting] = useState(false);
	const [scopeSizes, setScopeSizes] = useState<SyncScopeSizes | null>(null);
	const [mirrors, setMirrors] = useState<SyncBackendConfig[]>([]);
	const [mirrorsDirty, setMirrorsDirty] = useState(false);
	// Live per-mirror state from `sync:mirror`, replaced by the persisted
	// `lastSyncAt` / `lastError` on the next status refresh.
	const [mirrorLive, setMirrorLive] = useState<
		Record<
			number,
			{ status: "started" | "published" | "error"; error?: string }
		>
	>({});
	const [activeOrgId, setActiveOrgId] = useState("");
	const cloudSubject =
		form.agenteroSubject === "organization" ? "organization" : "user";
	const cloudUsage = useCloudUsage(
		cloudSubject,
		cloudSubject === "organization" ? activeOrgId || undefined : undefined,
	);

	useEffect(() => {
		let cancelled = false;
		void authClient.getSession().then((result) => {
			const id = result.data?.session.activeOrganizationId ?? "";
			if (!cancelled) setActiveOrgId(id);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const refresh = useCallback(async () => {
		if (!localVault) return;
		const id = ++requestId.current;
		const next = await syncGetStatus(localVault);
		if (id !== requestId.current) return;
		setStatus(next);
		setSyncing(next.running);
		if (mirrorsDirty) {
			// Keep an in-progress mirror edit from being overwritten by a status
			// refresh (the pane refreshes on every sync:state event).
		} else {
			setMirrors(next.mirrors.map((mirror) => mirror.config));
		}
		if (formVersion.current !== 0) return;
		formVersion.current++;
		if (next.config) {
			setForm(next.config);
			// Surface the advanced group when it holds non-default values.
			if (
				next.config.backend === "s3" &&
				(next.config.region !== "us-east-1" ||
					next.config.prefix !== "" ||
					!next.config.forcePathStyle)
			) {
				setAdvancedOpen(true);
			}
		} else {
			setForm(emptySyncConfig());
			setAdvancedOpen(false);
		}
	}, [localVault, mirrorsDirty]);

	useEffect(() => {
		void refresh().catch((error) => notifyError(errorMessage(error)));
		return () => {
			requestId.current++;
		};
	}, [refresh]);

	useEffect(() => {
		if (!localVault) return;
		const offs = [
			toSafeDisposer(
				events.syncState.listen((event) => {
					const payload: SyncStateEvent = event.payload;
					if (payload.vaultPath !== localVault) return;
					setSyncing(payload.status === "syncing");
					setSyncError(
						payload.status === "error"
							? (payload.error ?? t("sync.statusError"))
							: null,
					);
					if (payload.status !== "syncing") {
						setProgress(null);
						setMirrorLive({});
						void refresh().catch(() => undefined);
					}
					if (payload.status === "error") {
						const detail = payload.error ?? t("sync.statusError");
						notifyError(
							payload.errorCode === "sync_no_conditional_writes"
								? t("sync.noConditionalWrites")
								: detail,
							{
								id: `sync:${localVault}`,
								description:
									payload.errorCode === "sync_no_conditional_writes"
										? detail
										: undefined,
							},
						);
					}
				}),
			),
			toSafeDisposer(
				events.syncProgress.listen((event) => {
					const { vaultPath, phase, current, total } = event.payload;
					if (vaultPath === localVault && isSyncProgressPhase(phase)) {
						setProgress({ vaultPath, phase, current, total });
					}
				}),
			),
			toSafeDisposer(
				events.syncMirror.listen((event) => {
					const payload = event.payload;
					if (payload.vaultPath !== localVault) return;
					if (!isSyncMirrorPhase(payload.status)) return;
					setMirrorLive((prev) => ({
						...prev,
						[payload.index]: {
							status: payload.status as "started" | "published" | "error",
							error: payload.error ?? undefined,
						},
					}));
					if (payload.status !== "started") {
						void refresh().catch(() => undefined);
					}
				}),
			),
		];
		return () => {
			for (const off of offs) off();
		};
	}, [localVault, refresh, t]);

	useEffect(() => {
		if (!localVault) return;
		let cancelled = false;
		syncScopeSizes(localVault)
			.then((sizes) => {
				if (!cancelled) setScopeSizes(sizes);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [localVault]);

	if (!localVault) {
		return (
			<section>
				<PageTitle title={t("sync.title")} />
				<p className="text-muted-foreground text-sm">
					{t("sync.localVaultOnly")}
				</p>
			</section>
		);
	}

	const patch = (partial: Partial<SyncBackendConfig>) => {
		formVersion.current++;
		setForm((prev) => ({ ...prev, ...partial }));
	};

	const scope = form.scope;
	const patchScope = (key: keyof SyncBackendConfig["scope"], value: boolean) =>
		patch({ scope: { ...scope, [key]: value } });

	const isAgentero = form.backend === "agentero";
	const isWebdav = form.backend === "webdav";
	const isGit = form.backend === "git";
	const backendLocked = status?.configured === true;
	const providerLinks = isAgentero
		? []
		: isGit
			? GIT_PROVIDER_LINKS
			: isWebdav
				? WEBDAV_PROVIDER_LINKS
				: SYNC_PROVIDER_LINKS;
	const cloudBlocked =
		isAgentero &&
		(!cloudUsage?.signedIn ||
			cloudUsage.limit === 0 ||
			(cloudSubject === "organization" && !activeOrgId));

	const reportSyncError = (error: unknown) => {
		const detail = errorMessage(error);
		const code = error instanceof Error ? (error as ApiError).code : undefined;
		if (code === "sync_no_conditional_writes") {
			setSyncError(detail);
			notifyError(t("sync.noConditionalWrites"), { description: detail });
			return;
		}
		const message =
			code === "git_auth_failed"
				? t("sync.gitAuthFailed", { detail })
				: code === "git_tls_failed"
					? t("sync.gitTlsFailed", { detail })
					: detail;
		setSyncError(message);
		notifyError(message);
	};

	const save = async () => {
		const version = formVersion.current;
		setSaving(true);
		try {
			const next = await syncConfigure(localVault, form, mirrors);
			requestId.current++;
			setStatus(next);
			setMirrors(next.mirrors.map((mirror) => mirror.config));
			setMirrorsDirty(false);
			if (next.config && formVersion.current === version) {
				formVersion.current++;
				setForm(next.config);
			}
			setSyncError(null);
			notifySuccess(t("sync.saved"));
		} catch (error) {
			reportSyncError(error);
		} finally {
			setSaving(false);
		}
	};

	const runSync = async () => {
		setSyncing(true);
		try {
			const outcome = await syncNow(localVault);
			setSyncError(null);
			notifySuccess(
				t("sync.done", {
					up: outcome.uploaded,
					down: outcome.downloaded,
				}),
			);
			if (outcome.conflictCopies.length > 0) {
				notifySuccess(
					t("sync.conflicts", { count: outcome.conflictCopies.length }),
				);
			}
		} catch (error) {
			reportSyncError(error);
		} finally {
			setSyncing(false);
			setProgress(null);
			void refresh().catch(() => undefined);
		}
	};

	const disconnect = async () => {
		try {
			await syncDisconnect(localVault);
			requestId.current++;
			formVersion.current++;
			setStatus(null);
			setForm(emptySyncConfig());
			setSyncError(null);
			void refresh().catch(() => undefined);
		} catch (error) {
			reportSyncError(error);
		}
	};

	const openOverwrite = async (direction: SyncOverwriteDirection) => {
		try {
			const preview = await syncOverwritePreview(localVault, direction);
			setOverwriteDialog({ direction, preview });
		} catch (error) {
			reportSyncError(error);
		}
	};

	const confirmOverwrite = async () => {
		if (!overwriteDialog) return;
		setOverwriting(true);
		try {
			const outcome = await syncOverwrite(
				localVault,
				overwriteDialog.direction,
			);
			setOverwriteDialog(null);
			setSyncError(null);
			notifySuccess(
				t("sync.overwriteDone", {
					version: outcome.version,
					up: outcome.uploaded,
					down: outcome.downloaded,
					deleted: outcome.deletedLocal,
				}),
			);
		} catch (error) {
			reportSyncError(error);
		} finally {
			setOverwriting(false);
			void refresh().catch(() => undefined);
		}
	};

	const field = (
		key: keyof SyncBackendConfig,
		opts?: { type?: string; placeholder?: string },
	) => (
		<Input
			id={`sync-${key}`}
			className="w-64"
			type={opts?.type ?? "text"}
			placeholder={opts?.placeholder}
			value={String(form[key])}
			onChange={(e) => patch({ [key]: e.target.value })}
			autoComplete="off"
			spellCheck={false}
		/>
	);

	const statusText =
		syncing && progress
			? t(`sync.phase.${progress.phase}`, {
					current: progress.current,
					total: progress.total,
				})
			: status?.lastSyncAt
				? t("sync.lastSync", {
						time: formatLocaleTimestamp(status.lastSyncAt),
					})
				: status?.configured
					? t("sync.neverSynced")
					: null;
	const syncStatusLabel = syncError
		? t("sync.statusError")
		: syncing
			? t("sync.statusSyncing")
			: status?.configured
				? t("sync.statusConnected")
				: t("sync.statusDisconnected");
	const syncStatusDotClass = syncError
		? "bg-destructive"
		: syncing
			? "bg-sky-500"
			: status?.configured
				? "bg-emerald-500"
				: "bg-muted-foreground/35";
	const configChanged =
		JSON.stringify(form) !== JSON.stringify(status?.config) ||
		JSON.stringify(mirrors) !==
			JSON.stringify((status?.mirrors ?? []).map((mirror) => mirror.config));
	const primaryAction =
		!status?.configured || configChanged ? (
			<Button
				type="button"
				size="sm"
				onClick={() => void save()}
				disabled={saving || syncing || cloudBlocked}
			>
				{saving ? (
					<LoaderCircle data-icon="inline-start" className="animate-spin" />
				) : null}
				{isAgentero && !status?.configured
					? t("sync.useAccount")
					: status?.configured
						? t("sync.save")
						: t("sync.connect")}
			</Button>
		) : (
			<Button
				type="button"
				size="sm"
				onClick={() => void runSync()}
				disabled={syncing}
			>
				{syncing ? (
					<LoaderCircle data-icon="inline-start" className="animate-spin" />
				) : (
					<CloudUpload data-icon="inline-start" />
				)}
				{t("sync.syncNow")}
			</Button>
		);

	return (
		<section>
			<PageTitle
				title={
					<>
						<span className="inline-flex items-center gap-2">
							{t("sync.title")}
							<span
								role="status"
								aria-label={syncStatusLabel}
								title={syncError ?? syncStatusLabel}
								className={cn("size-2 rounded-full", syncStatusDotClass)}
							/>
						</span>
						{statusText ? (
							<span className="ml-2 font-normal text-muted-foreground text-xs">
								{statusText}
							</span>
						) : null}
					</>
				}
				actions={primaryAction}
			/>

			<div className="mb-3 flex flex-wrap items-center gap-2">
				<span id="sync-vault-label" className="text-muted-foreground text-xs">
					{t("sync.vault")}
				</span>
				<Select
					value={localVault ?? undefined}
					onValueChange={(value) => setSelectedVault(value || null)}
					disabled={vaults.length === 0}
				>
					<SelectTrigger
						id="sync-vault"
						size="sm"
						className="w-44"
						aria-labelledby="sync-vault-label"
					>
						<SelectValue placeholder={t("sync.vaultPlaceholder")}>
							{localVault ? vaultDisplayName(localVault) : undefined}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{vaults.map((path) => (
							<SelectItem key={path} value={path}>
								<span className="flex min-w-0 flex-col items-start">
									<span className="truncate">{vaultDisplayName(path)}</span>
									<span className="truncate text-muted-foreground text-xs">
										{displayPath(path)}
									</span>
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="mb-3 flex flex-wrap items-center gap-2">
				<span id="sync-backend-label" className="text-muted-foreground text-xs">
					{t("sync.backend")}
				</span>
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex">
							<Select
								value={form.backend}
								onValueChange={(value) => {
									if (
										value === "agentero" ||
										value === "s3" ||
										value === "webdav" ||
										value === "git"
									) {
										patch({ backend: value });
									}
								}}
								disabled={backendLocked}
							>
								<SelectTrigger
									id="sync-backend"
									size="sm"
									className="w-44"
									aria-labelledby="sync-backend-label"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{BACKEND_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{t(option.labelKey)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</span>
					</TooltipTrigger>
					{backendLocked ? (
						<TooltipContent side="bottom">
							{t("sync.backendLocked")}
						</TooltipContent>
					) : null}
				</Tooltip>
				<div className="ml-auto flex flex-wrap items-center gap-1.5">
					{providerLinks.map((provider) => {
						const Icon = provider.icon;
						return (
							<Tooltip key={provider.id}>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon-lg"
										variant="outline"
										className="size-9 bg-background"
										aria-label={t("sync.providerDocsAria", {
											name: provider.name,
										})}
										onClick={() => openExternalUrl(provider.docsUrl)}
									>
										<Icon
											className={cn("size-5", provider.iconClassName)}
											aria-hidden
										/>
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">{provider.name}</TooltipContent>
							</Tooltip>
						);
					})}
				</div>
			</div>

			{isAgentero ? (
				<SettingsGroup>
					<SettingsRow label={t("sync.space")} htmlFor="sync-space">
						<Select
							value={form.agenteroSubject}
							onValueChange={(value) => {
								if (value !== "user" && value !== "organization") return;
								patch({
									agenteroSubject: value,
									agenteroOrgId: value === "organization" ? activeOrgId : "",
								});
							}}
							disabled={backendLocked}
						>
							<SelectTrigger id="sync-space" size="sm" className="w-44">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="user">{t("sync.spacePersonal")}</SelectItem>
								<SelectItem value="organization" disabled={!activeOrgId}>
									{t("sync.spaceTeam")}
								</SelectItem>
							</SelectContent>
						</Select>
					</SettingsRow>
					<div className="px-3 py-2">
						<CloudUsageLine
							subject={cloudSubject}
							orgId={
								cloudSubject === "organization"
									? activeOrgId || undefined
									: undefined
							}
						/>
						{cloudSubject === "organization" && !activeOrgId ? (
							<p className="text-muted-foreground text-xs">
								{t("sync.noTeam")}
							</p>
						) : null}
					</div>
				</SettingsGroup>
			) : isGit ? (
				<SettingsGroup>
					<SettingsRow
						label={t("sync.gitRemote")}
						description={t("sync.gitRemoteHint")}
						htmlFor="sync-gitRemote"
					>
						{field("gitRemote", {
							placeholder: "https://git.example.com/you/papers.git",
						})}
					</SettingsRow>
					<SettingsRow label={t("sync.gitBranch")} htmlFor="sync-gitBranch">
						{field("gitBranch", { placeholder: "main" })}
					</SettingsRow>
					<SettingsRow
						label={t("sync.gitAllowInsecureHttp")}
						description={t("sync.gitAllowInsecureHttpHint")}
						htmlFor="sync-gitAllowInsecureHttp"
					>
						<Switch
							id="sync-gitAllowInsecureHttp"
							checked={form.gitAllowInsecureHttp}
							onCheckedChange={(checked) =>
								patch({ gitAllowInsecureHttp: checked })
							}
						/>
					</SettingsRow>
					<SettingsRow
						label={t("sync.gitSslCa")}
						description={t("sync.gitSslCaHint")}
						htmlFor="sync-gitSslCaInfo"
					>
						{field("gitSslCaInfo", { placeholder: "/path/to/ca.pem" })}
					</SettingsRow>
				</SettingsGroup>
			) : isWebdav ? (
				<>
					{status?.configured &&
					!form.conditionalWrites &&
					!degradedNoticeDismissed ? (
						<div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3.5 py-2 text-xs">
							<TriangleAlert
								className="size-4 shrink-0 text-amber-600 dark:text-amber-500"
								aria-hidden
							/>
							<span className="min-w-0 flex-1">
								{t("sync.noConditionalWritesShort")}
							</span>
							<button
								type="button"
								className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
								aria-label={t("sync.dismissNotice")}
								onClick={() => {
									writeJsonStorage(DEGRADED_NOTICE_DISMISSED_KEY, true);
									setDegradedNoticeDismissed(true);
								}}
							>
								<X className="size-3.5" aria-hidden />
							</button>
						</div>
					) : null}
					<SettingsGroup>
						<SettingsRow label={t("sync.serverUrl")} htmlFor="sync-webdavUrl">
							{field("webdavUrl", {
								placeholder: "https://dav.jianguoyun.com/dav/agentero",
							})}
						</SettingsRow>
						<SettingsRow
							label={t("sync.username")}
							htmlFor="sync-webdavUsername"
						>
							{field("webdavUsername")}
						</SettingsRow>
						<SettingsRow
							label={t("sync.password")}
							htmlFor="sync-webdavPassword"
						>
							{field("webdavPassword", { type: "password" })}
						</SettingsRow>
						{status?.configured && !form.conditionalWrites ? (
							<SettingsRow
								label={
									<HelpLabel
										label={t("sync.allowDegradedSync")}
										help={t("sync.degradedSyncRisk")}
									/>
								}
								htmlFor="sync-allowDegradedSync"
							>
								<Switch
									id="sync-allowDegradedSync"
									checked={form.allowDegradedSync}
									onCheckedChange={(value) =>
										patch({ allowDegradedSync: value })
									}
									disabled={syncing || saving}
								/>
							</SettingsRow>
						) : null}
						{status?.configured && !configChanged ? (
							<div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={syncing || saving}
									onClick={() => void openOverwrite("remoteToLocal")}
								>
									<ArrowDownToLine data-icon="inline-start" />
									{t("sync.overwritePull")}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={syncing || saving}
									onClick={() => void openOverwrite("localToRemote")}
								>
									<ArrowUpFromLine data-icon="inline-start" />
									{t("sync.overwritePush")}
								</Button>
							</div>
						) : null}
					</SettingsGroup>
				</>
			) : (
				<SettingsGroup>
					<SettingsRow label={t("sync.endpoint")} htmlFor="sync-endpoint">
						{field("endpoint", { placeholder: "https://…" })}
					</SettingsRow>
					<SettingsRow label={t("sync.bucket")} htmlFor="sync-bucket">
						{field("bucket")}
					</SettingsRow>
					<SettingsRow label={t("sync.accessKey")} htmlFor="sync-accessKey">
						{field("accessKey")}
					</SettingsRow>
					<SettingsRow label={t("sync.secretKey")} htmlFor="sync-secretKey">
						{field("secretKey", { type: "password" })}
					</SettingsRow>
				</SettingsGroup>
			)}

			<SettingsGroup>
				<SettingsRow label={t("sync.autoSync")} htmlFor="sync-autoSync">
					<Switch
						id="sync-autoSync"
						checked={form.autoSync}
						onCheckedChange={(checked) => patch({ autoSync: checked })}
					/>
				</SettingsRow>
				{form.autoSync ? (
					<SettingsRow label={t("sync.interval")} htmlFor="sync-interval">
						<Select
							value={String(form.intervalMinutes)}
							onValueChange={(value) =>
								patch({ intervalMinutes: Number(value) })
							}
						>
							<SelectTrigger id="sync-interval" size="sm" className="w-32">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{SYNC_INTERVAL_CHOICES.map((minutes) => (
									<SelectItem key={minutes} value={String(minutes)}>
										{t("sync.intervalMinutes", { count: minutes })}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SettingsRow>
				) : null}
			</SettingsGroup>

			<SettingsSectionLabel className="mt-4">
				<HelpLabel
					label={t("sync.scope")}
					help={t(isGit ? "sync.scopeHintGit" : "sync.scopeHint")}
				/>
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("sync.scopePdf")} htmlFor="sync-scope-pdf">
					<span className="flex items-center gap-2">
						{scopeSizes ? (
							<span className="text-muted-foreground text-xs tabular-nums">
								{formatBytes(scopeSizes.pdf)}
							</span>
						) : null}
						<Switch
							id="sync-scope-pdf"
							checked={scope.pdf}
							onCheckedChange={(checked) => patchScope("pdf", checked)}
						/>
					</span>
				</SettingsRow>
				<SettingsRow label={t("sync.scopeSource")} htmlFor="sync-scope-source">
					<span className="flex items-center gap-2">
						{scopeSizes ? (
							<span className="text-muted-foreground text-xs tabular-nums">
								{formatBytes(scopeSizes.source)}
							</span>
						) : null}
						<Switch
							id="sync-scope-source"
							checked={scope.source}
							onCheckedChange={(checked) => patchScope("source", checked)}
						/>
					</span>
				</SettingsRow>
				<SettingsRow
					label={t("sync.scopeAttachments")}
					htmlFor="sync-scope-attachments"
				>
					<span className="flex items-center gap-2">
						{scopeSizes ? (
							<span className="text-muted-foreground text-xs tabular-nums">
								{formatBytes(scopeSizes.attachments)}
							</span>
						) : null}
						<Switch
							id="sync-scope-attachments"
							checked={scope.attachments}
							onCheckedChange={(checked) => patchScope("attachments", checked)}
						/>
					</span>
				</SettingsRow>
			</SettingsGroup>

			{form.backend === "s3" ? (
				<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
					<CollapsibleTrigger asChild>
						<button
							type="button"
							className="mb-2 flex items-center gap-1 text-muted-foreground text-xs outline-none transition-colors hover:text-foreground"
							aria-label={t("sync.advanced")}
						>
							<ChevronRight
								className={cn(
									"size-3.5 transition-transform",
									advancedOpen && "rotate-90",
								)}
							/>
							{t("sync.advanced")}
						</button>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<SettingsGroup>
							<SettingsRow label={t("sync.region")} htmlFor="sync-region">
								{field("region")}
							</SettingsRow>
							<SettingsRow
								label={
									<HelpLabel
										label={t("sync.prefix")}
										help={t("sync.prefixHint")}
									/>
								}
								htmlFor="sync-prefix"
							>
								{field("prefix")}
							</SettingsRow>
							<SettingsRow
								label={
									<HelpLabel
										label={t("sync.pathStyle")}
										help={t("sync.pathStyleHint")}
									/>
								}
								htmlFor="sync-pathStyle"
							>
								<Switch
									id="sync-pathStyle"
									checked={form.forcePathStyle}
									onCheckedChange={(checked) =>
										patch({ forcePathStyle: checked })
									}
								/>
							</SettingsRow>
						</SettingsGroup>
					</CollapsibleContent>
				</Collapsible>
			) : null}

			<MirrorSection
				mirrors={mirrors}
				statuses={status?.mirrors ?? []}
				live={mirrorLive}
				onChange={(next) => {
					setMirrorsDirty(true);
					setMirrors(next);
				}}
			/>

			<div className="flex items-center gap-2">
				{status?.configured ? (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => void disconnect()}
						disabled={syncing}
					>
						<Unplug data-icon="inline-start" />
						{t("sync.disconnect")}
					</Button>
				) : null}
			</div>
			<Dialog
				open={overwriteDialog !== null}
				onOpenChange={(open) => {
					if (!open && !overwriting) setOverwriteDialog(null);
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							{overwriteDialog?.direction === "remoteToLocal"
								? t("sync.overwritePullTitle")
								: t("sync.overwritePushTitle")}
						</DialogTitle>
						<DialogDescription>
							{overwriteDialog?.direction === "remoteToLocal"
								? t("sync.overwritePullBody", {
										delete: overwriteDialog.preview.willDeleteLocal,
										download: overwriteDialog.preview.willDownload,
										version: overwriteDialog.preview.remoteVersion,
									})
								: overwriteDialog
									? t("sync.overwritePushBody", {
											upload: overwriteDialog.preview.willUpload,
											remove: overwriteDialog.preview.willRemoveRemote,
											version: overwriteDialog.preview.remoteVersion,
										})
									: null}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOverwriteDialog(null)}
							disabled={overwriting}
						>
							{t("sync.cancel")}
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => void confirmOverwrite()}
							disabled={overwriting}
						>
							{overwriting ? (
								<LoaderCircle
									data-icon="inline-start"
									className="animate-spin"
								/>
							) : null}
							{t("sync.overwriteConfirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}

/** True when two bindings point at the same mirror store (compare like
 * `remote_identity` does: backend + address + account, never secrets). */
function sameMirrorTarget(a: SyncBackendConfig, b: SyncBackendConfig): boolean {
	if (a.backend !== b.backend) return false;
	if (a.backend === "webdav") {
		return (
			a.webdavUrl.trim().replace(/\/+$/, "") ===
				b.webdavUrl.trim().replace(/\/+$/, "") &&
			a.webdavUsername.trim() === b.webdavUsername.trim()
		);
	}
	if (a.backend === "git") {
		return (
			a.gitRemote.trim() === b.gitRemote.trim() &&
			a.gitBranch.trim() === b.gitBranch.trim()
		);
	}
	if (a.backend === "s3") {
		return (
			a.endpoint.trim() === b.endpoint.trim() &&
			a.bucket.trim() === b.bucket.trim() &&
			a.prefix.trim() === b.prefix.trim() &&
			a.accessKey.trim() === b.accessKey.trim()
		);
	}
	return false;
}

/** Read-only mirrors: published after each primary pass, never read back. */
function MirrorSection({
	mirrors,
	statuses,
	live,
	onChange,
}: {
	mirrors: SyncBackendConfig[];
	statuses: SyncMirrorStatus[];
	live: Record<
		number,
		{ status: "started" | "published" | "error"; error?: string }
	>;
	onChange: (next: SyncBackendConfig[]) => void;
}) {
	const { t } = useTranslation("settings");
	const patch = (index: number, partial: Partial<SyncBackendConfig>) =>
		onChange(
			mirrors.map((mirror, i) =>
				i === index ? { ...mirror, ...partial } : mirror,
			),
		);

	const field = (
		index: number,
		key: keyof SyncBackendConfig,
		label: string,
		type: "text" | "password" = "text",
		placeholder?: string,
	) => (
		<Input
			key={String(key)}
			type={type}
			value={String(mirrors[index][key] ?? "")}
			onChange={(event) =>
				patch(index, {
					[key]: event.target.value,
				} as Partial<SyncBackendConfig>)
			}
			placeholder={placeholder}
			aria-label={label}
			className="h-8 text-xs"
		/>
	);

	return (
		<>
			<SettingsSectionLabel className="mt-4">
				<HelpLabel label={t("sync.mirrors")} help={t("sync.mirrorsHint")} />
			</SettingsSectionLabel>
			<SettingsGroup>
				{mirrors.map((mirror, index) => {
					const status = statuses.find((entry) =>
						sameMirrorTarget(entry.config, mirror),
					);
					const liveState = live[index];
					const liveStatus = liveState?.status;
					const dot =
						liveStatus === "error" || status?.lastError
							? "bg-destructive"
							: liveStatus === "started"
								? "bg-sky-500"
								: liveStatus === "published" || status?.lastSyncAt
									? "bg-emerald-500"
									: "bg-muted-foreground/35";
					const statusLabel =
						liveStatus === "started"
							? t("sync.mirrorPublishing")
							: liveStatus === "error"
								? (liveState?.error ?? t("sync.mirrorError"))
								: status?.lastError
									? t("sync.mirrorError")
									: status?.lastSyncAt
										? t("sync.mirrorLastPublished", {
												time: formatLocaleTimestamp(status.lastSyncAt),
											})
										: t("sync.mirrorNeverPublished");
					const statusTitle =
						liveStatus === "error"
							? (liveState?.error ?? statusLabel)
							: (status?.lastError ?? statusLabel);
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: controlled rows, append/remove only
							key={`${mirror.backend}-${index}`}
							className="space-y-2 border-border/50 border-t px-3 py-2 first:border-t-0"
						>
							<div className="flex flex-wrap items-center gap-2">
								<Select
									value={mirror.backend}
									onValueChange={(value) => {
										if (
											value !== "s3" &&
											value !== "webdav" &&
											value !== "git"
										) {
											return;
										}
										patch(index, { ...emptySyncConfig(value) });
									}}
								>
									<SelectTrigger
										size="sm"
										className="w-36"
										aria-label={t("sync.mirrorBackend")}
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="webdav">
											{t("sync.backendWebdav")}
										</SelectItem>
										<SelectItem value="git">{t("sync.backendGit")}</SelectItem>
										<SelectItem value="s3">{t("sync.backendS3")}</SelectItem>
									</SelectContent>
								</Select>
								<span
									role="status"
									aria-label={statusLabel}
									title={statusTitle}
									className={cn("size-2 rounded-full", dot)}
								/>
								<span className="text-muted-foreground text-xs">
									{t("sync.mirrorReadOnly")}
								</span>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="ml-auto"
									aria-label={t("sync.mirrorRemove")}
									onClick={() =>
										onChange(mirrors.filter((_, i) => i !== index))
									}
								>
									<Trash2 className="size-4" />
								</Button>
							</div>
							<div className="grid gap-2 sm:grid-cols-2">
								{mirror.backend === "webdav" ? (
									<>
										{field(
											index,
											"webdavUrl",
											t("sync.serverUrl"),
											"text",
											"https://dav.example.com/dav/agentero/",
										)}
										{field(index, "webdavUsername", t("sync.username"))}
										{field(
											index,
											"webdavPassword",
											t("sync.password"),
											"password",
										)}
									</>
								) : mirror.backend === "git" ? (
									<>
										{field(
											index,
											"gitRemote",
											t("sync.gitRemote"),
											"text",
											"git@github.com:you/vault.git",
										)}
										{field(index, "gitBranch", t("sync.gitBranch"))}
									</>
								) : (
									<>
										{field(index, "endpoint", t("sync.endpoint"))}
										{field(index, "bucket", t("sync.bucket"))}
										{field(index, "prefix", t("sync.prefix"))}
										{field(index, "accessKey", t("sync.accessKey"))}
										{field(index, "secretKey", t("sync.secretKey"), "password")}
									</>
								)}
							</div>
						</div>
					);
				})}
				<div className="px-3 py-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => onChange([...mirrors, emptySyncConfig("webdav")])}
						disabled={mirrors.length >= 3}
					>
						<Plus data-icon="inline-start" />
						{t("sync.mirrorAdd")}
					</Button>
				</div>
			</SettingsGroup>
		</>
	);
}
