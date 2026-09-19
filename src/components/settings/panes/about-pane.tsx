import { getVersion } from "@tauri-apps/api/app";
import { appLogDir } from "@tauri-apps/api/path";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
	Download,
	FolderOpen,
	LoaderCircle,
	MousePointerClick,
	RefreshCw,
	Star,
	Telescope,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import agenteroAppIcon from "@/assets/agentero-app-icon.svg";
import { CompactCodeBlock } from "@/components/ai-elements/code-block";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { lifecycleErrorMessage } from "@/lib/agent/lifecycle-error";
import {
	plazaScratchClear,
	plazaScratchStats,
} from "@/lib/agent/plaza-scratch";
import {
	type CliInstallStatus,
	type FinderServiceStatus,
	fetchCliInstallStatus,
	fetchFinderServiceStatus,
	installCliCommand,
	installFinderService,
	uninstallCliCommand,
	uninstallFinderService,
} from "@/lib/cli/api";
import { errorText } from "@/lib/core/error";
import { clearLogs } from "@/lib/core/logger";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isMacOS, isTauri, isWindows } from "@/lib/core/tauri";
import {
	checkForUpdate,
	getUpdateSnapshot,
	installAvailableUpdate,
	subscribeUpdate,
	type UpdateSnapshot,
} from "@/lib/update";

/** Same as README / homebrew-agentero Formula (headless CLI, not the desktop cask). */
const CLI_BREW_INSTALL_COMMAND =
	"brew tap poco-ai/agentero\nbrew install agentero";

const GITHUB_REPO_URL = "https://github.com/poco-ai/Agentero";

export function AboutPane() {
	const { t } = useTranslation("settings");
	const [version, setVersion] = useState<string>();
	const [update, setUpdate] = useState<UpdateSnapshot>(getUpdateSnapshot);
	const [cli, setCli] = useState<CliInstallStatus | null>(null);
	const [cliBusy, setCliBusy] = useState(false);
	const [cliLoading, setCliLoading] = useState(false);
	const [finder, setFinder] = useState<FinderServiceStatus | null>(null);
	const [finderBusy, setFinderBusy] = useState(false);
	const [logsBusy, setLogsBusy] = useState(false);
	const [scratchStats, setScratchStats] = useState<{
		papers: number;
		bytes: number;
	} | null>(null);
	const [scratchBusy, setScratchBusy] = useState(false);
	const isMac = useMemo(() => isMacOS(), []);
	const isWin = useMemo(() => isWindows(), []);

	const refreshCli = useCallback(async () => {
		if (!isTauri()) return;
		setCliLoading(true);
		try {
			const status = await fetchCliInstallStatus();
			setCli(status);
		} catch {
			notifyError(t("about.cli.statusFailed"));
		} finally {
			setCliLoading(false);
		}
	}, [t]);

	const refreshFinder = useCallback(async () => {
		if (!isTauri() || !isMac) return;
		try {
			setFinder(await fetchFinderServiceStatus());
		} catch {
			setFinder(null);
		}
	}, [isMac]);

	useEffect(() => {
		void getVersion()
			.then(setVersion)
			.catch(() => undefined);
	}, []);
	useEffect(() => subscribeUpdate(setUpdate), []);
	useEffect(() => {
		void refreshCli();
	}, [refreshCli]);
	useEffect(() => {
		void refreshFinder();
	}, [refreshFinder]);

	const checking = update.phase === "checking";
	const installing =
		update.phase === "downloading" || update.phase === "installing";
	const onCheck = () => {
		void checkForUpdate();
	};
	const onInstall = () => {
		void installAvailableUpdate().then((next) => {
			if (next.phase === "error") {
				notifyError(t("about.update.installFailed"));
			}
		});
	};
	const installErrorText = (err: unknown) =>
		lifecycleErrorMessage(errorText(err), (key, options) =>
			t(key, { ...options, defaultValue: "" }),
		);
	const onInstallCli = () => {
		setCliBusy(true);
		void installCliCommand()
			.then(async (res) => {
				setCli(res.status);
				await refreshCli();
				notifySuccess(
					res.action === "download-install"
						? t("about.cli.downloadInstallSuccess")
						: t("about.cli.installSuccess"),
				);
			})
			// Surface the Host error text: silent failures here are exactly what
			// makes users guess at causes (e.g. "64-bit not supported").
			.catch((err) =>
				notifyError(t("about.cli.installFailed"), {
					description: installErrorText(err),
				}),
			)
			.finally(() => setCliBusy(false));
	};
	const onUninstallCli = () => {
		setCliBusy(true);
		void uninstallCliCommand()
			.then(async (res) => {
				setCli(res.status);
				await refreshCli();
				notifySuccess(t("about.cli.uninstallSuccess"));
			})
			.catch((err) =>
				notifyError(t("about.cli.uninstallFailed"), {
					description: err instanceof Error ? err.message : String(err),
				}),
			)
			.finally(() => setCliBusy(false));
	};
	const onInstallFinder = () => {
		setFinderBusy(true);
		void installFinderService()
			.then(async (status) => {
				setFinder(status);
				await refreshFinder();
				notifySuccess(t("about.finder.installSuccess"));
			})
			.catch((err) =>
				notifyError(t("about.finder.installFailed"), {
					description: installErrorText(err),
				}),
			)
			.finally(() => setFinderBusy(false));
	};
	const onUninstallFinder = () => {
		setFinderBusy(true);
		void uninstallFinderService()
			.then(async (status) => {
				setFinder(status);
				await refreshFinder();
				notifySuccess(t("about.finder.uninstallSuccess"));
			})
			.catch((err) =>
				notifyError(t("about.finder.uninstallFailed"), {
					description: err instanceof Error ? err.message : String(err),
				}),
			)
			.finally(() => setFinderBusy(false));
	};
	const onOpenCliRelease = () => {
		const url = cli?.releasePageUrl;
		if (!url) return;
		void openUrl(url).catch(() =>
			notifyError(t("about.cli.openReleaseFailed")),
		);
	};
	const onOpenLogFolder = () => {
		void appLogDir()
			.then((dir) => openPath(dir))
			.catch((err) => {
				console.error("open log folder failed", err);
				notifyError(t("about.logs.openFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			});
	};
	const onClearLogs = () => {
		setLogsBusy(true);
		void clearLogs()
			.then(() => notifySuccess(t("about.logs.clearDone")))
			.catch((err) =>
				notifyError(t("about.logs.clearFailed"), {
					description: err instanceof Error ? err.message : String(err),
				}),
			)
			.finally(() => setLogsBusy(false));
	};

	const refreshScratchStats = useCallback(() => {
		if (!isTauri()) return;
		void plazaScratchStats()
			.then(setScratchStats)
			.catch(() => setScratchStats(null));
	}, []);

	useEffect(() => {
		refreshScratchStats();
	}, [refreshScratchStats]);

	const onClearScratch = () => {
		setScratchBusy(true);
		void plazaScratchClear()
			.then(async () => {
				notifySuccess(t("about.scratch.clearDone"));
				refreshScratchStats();
			})
			.catch((err) =>
				notifyError(t("about.scratch.clearFailed"), {
					description: err instanceof Error ? err.message : String(err),
				}),
			)
			.finally(() => setScratchBusy(false));
	};

	// Derive the status line from structured fields; the Host `message` is
	// English-only debug text and must never reach the UI verbatim (i18n).
	const cliDescription = (() => {
		if (!cli) {
			return cliLoading ? "…" : t("about.cli.statusFailed");
		}
		if (cli.installed && !cli.shimCurrent) {
			return t("about.cli.versionMismatch", {
				cli: cli.cliVersion ?? "?",
				app: cli.appVersion,
			});
		}
		if (cli.installed && !cli.preferredBinOnPath) {
			return t("about.cli.pathMissing");
		}
		if (!cli.canInstall) {
			return t("about.cli.notBundled");
		}
		return t("about.cli.description");
	})();

	const needsCliUpdate = Boolean(
		cli?.installed && !cli.shimCurrent && cli.canInstall,
	);
	const canInstallCli = Boolean(cli?.canInstall) && !cliBusy;
	const showInstall = !cli?.installed || needsCliUpdate;
	const showBrewCliHint = isMac && showInstall && Boolean(cli?.brewAvailable);
	const cliVerifyCommand =
		isWin && cli?.installPath
			? `call "${cli.installPath.replaceAll('"', '""')}" --version`
			: `${cli?.commandName ?? "agentero-cli"} --version`;

	const showFinderRow = isMac && isTauri() && finder?.supported !== false;
	const needsFinderUpdate = Boolean(finder?.installed && !finder.current);
	const finderDescription = (() => {
		if (!finder) return "…";
		if (finder.installed && !finder.current) return t("about.finder.stale");
		if (finder.installed) return t("about.finder.descriptionInstalled");
		return t("about.finder.description");
	})();

	return (
		<>
			<PageTitle
				title={t("about.title")}
				actions={
					<Button
						variant="outline"
						size="sm"
						onClick={() => openExternalUrl(GITHUB_REPO_URL)}
					>
						<Star data-icon="inline-start" className="star-twinkle" />
						{t("about.starGithub")}
					</Button>
				}
			/>
			<SettingsGroup>
				<div className="flex items-center justify-between gap-4 px-3.5 py-4">
					<div className="flex min-w-0 items-center gap-3">
						<img
							src={agenteroAppIcon}
							alt=""
							aria-hidden
							className="size-10 shrink-0 rounded-lg"
						/>
						<div className="min-w-0 space-y-0.5">
							<p className="font-semibold text-base text-foreground">
								Agentero
							</p>
							{version && (
								<p className="text-muted-foreground text-xs">
									{t("about.version", { version })}
								</p>
							)}
						</div>
					</div>
					<div className="flex shrink-0 items-center">
						{update.phase === "available" ? (
							<Button size="sm" onClick={onInstall}>
								<Download data-icon="inline-start" />
								{t("about.update.downloadInstall")}
							</Button>
						) : update.phase === "unsupported" ? null : (
							<Button
								variant="outline"
								size="sm"
								disabled={checking || installing}
								onClick={onCheck}
							>
								{checking || installing ? (
									<LoaderCircle
										data-icon="inline-start"
										className="animate-spin"
									/>
								) : (
									<RefreshCw data-icon="inline-start" />
								)}
								{t("about.update.check")}
							</Button>
						)}
					</div>
				</div>
				{update.phase === "available" && update.notes?.trim() ? (
					<div className="border-t px-3.5 py-2.5 text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
						{update.notes.trim()}
					</div>
				) : null}
			</SettingsGroup>
			{isTauri() ? (
				<SettingsGroup>
					<SettingsRow
						label={
							<span className="inline-flex items-center gap-1.5">
								<Terminal
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								{t("about.cli.label")}
							</span>
						}
						description={cliDescription}
					>
						<div className="flex flex-wrap items-center justify-end gap-2">
							{cli?.installed ? (
								<Button
									variant="outline"
									size="sm"
									disabled={cliBusy || cliLoading}
									onClick={onUninstallCli}
								>
									{cliBusy ? (
										<LoaderCircle
											data-icon="inline-start"
											className="animate-spin"
										/>
									) : null}
									{t("about.cli.uninstall")}
								</Button>
							) : null}
							{showInstall ? (
								<Button
									size="sm"
									disabled={!canInstallCli || cliLoading}
									onClick={onInstallCli}
								>
									{cliBusy ? (
										<LoaderCircle
											data-icon="inline-start"
											className="animate-spin"
										/>
									) : (
										<Download data-icon="inline-start" />
									)}
									{needsCliUpdate
										? t("about.cli.update")
										: t("about.cli.install")}
								</Button>
							) : null}
							{!cli?.canInstall && cli?.releasePageUrl ? (
								<Button
									variant="outline"
									size="sm"
									disabled={cliLoading}
									onClick={onOpenCliRelease}
								>
									{t("about.cli.openRelease")}
								</Button>
							) : null}
						</div>
					</SettingsRow>
					{showBrewCliHint ? (
						<div className="border-t px-3.5 py-3">
							<p className="mb-2 text-muted-foreground text-xs leading-relaxed">
								{t("about.cli.brewHint")}
							</p>
							<CompactCodeBlock
								code={CLI_BREW_INSTALL_COMMAND}
								language="shell"
								wrap
								className="[&_pre]:opacity-75"
								copyButtonProps={{
									"aria-label": t("about.cli.brewCopy"),
									onCopy: () => notifySuccess(t("about.cli.brewCopied")),
									onError: () => notifyError(t("about.cli.brewCopyFailed")),
								}}
							/>
						</div>
					) : null}
					{cli?.installed && cli.shimCurrent && cli.commandName ? (
						<div className="border-t px-3.5 py-3">
							<p className="mb-2 text-muted-foreground text-xs leading-relaxed">
								{isWin
									? t("about.cli.windowsVerifyHint")
									: t("about.cli.verifyHint")}
							</p>
							<CompactCodeBlock
								code={cliVerifyCommand}
								language="shell"
								wrap
								className="[&_pre]:opacity-75"
								copyButtonProps={{
									"aria-label": t("about.cli.verifyCopy"),
									onCopy: () => notifySuccess(t("about.cli.verifyCopied")),
									onError: () => notifyError(t("about.cli.verifyCopyFailed")),
								}}
							/>
						</div>
					) : null}
				</SettingsGroup>
			) : null}
			{showFinderRow ? (
				<SettingsGroup>
					<SettingsRow
						label={
							<span className="inline-flex items-center gap-1.5">
								<MousePointerClick
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								{t("about.finder.label")}
							</span>
						}
						description={finderDescription}
					>
						<div className="flex flex-wrap items-center justify-end gap-2">
							{finder?.installed ? (
								<Button
									variant="outline"
									size="sm"
									disabled={finderBusy}
									onClick={onUninstallFinder}
								>
									{finderBusy ? (
										<LoaderCircle
											data-icon="inline-start"
											className="animate-spin"
										/>
									) : null}
									{t("about.finder.uninstall")}
								</Button>
							) : null}
							{!finder?.installed || needsFinderUpdate ? (
								<Button
									size="sm"
									disabled={finderBusy || !finder}
									onClick={onInstallFinder}
								>
									{finderBusy ? (
										<LoaderCircle
											data-icon="inline-start"
											className="animate-spin"
										/>
									) : (
										<Download data-icon="inline-start" />
									)}
									{needsFinderUpdate
										? t("about.finder.update")
										: t("about.finder.install")}
								</Button>
							) : null}
						</div>
					</SettingsRow>
				</SettingsGroup>
			) : null}
			{isTauri() ? (
				<SettingsGroup>
					<SettingsRow
						label={
							<span className="inline-flex items-center gap-1.5">
								<FolderOpen
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								{t("about.logs.label")}
							</span>
						}
					>
						<div className="flex items-center gap-2">
							<Button variant="outline" size="sm" onClick={onOpenLogFolder}>
								{t("about.logs.open")}
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={logsBusy}
								onClick={onClearLogs}
							>
								{logsBusy ? (
									<LoaderCircle
										data-icon="inline-start"
										className="animate-spin"
									/>
								) : null}
								{t("about.logs.clear")}
							</Button>
						</div>
					</SettingsRow>
				</SettingsGroup>
			) : null}
			{isTauri() ? (
				<SettingsGroup>
					<SettingsRow
						label={
							<span className="inline-flex items-center gap-1.5">
								<Telescope
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								{t("about.scratch.label")}
							</span>
						}
					>
						<div className="flex items-center gap-2">
							{scratchStats?.bytes ? (
								<span className="text-muted-foreground text-xs">
									{t("about.scratch.summary", {
										papers: scratchStats.papers,
										size: `${(scratchStats.bytes / 1024 / 1024).toFixed(1)} MB`,
									})}
								</span>
							) : null}
							{/* Gate on bytes, not papers: failed parses leave an
							    orphaned paper.pdf (bytes > 0, papers == 0) that
							    must stay clearable. */}
							<Button
								variant="outline"
								size="sm"
								disabled={scratchBusy || !scratchStats?.bytes}
								onClick={onClearScratch}
							>
								{scratchBusy ? (
									<LoaderCircle
										data-icon="inline-start"
										className="animate-spin"
									/>
								) : null}
								{t("about.scratch.clear")}
							</Button>
						</div>
					</SettingsRow>
				</SettingsGroup>
			) : null}
		</>
	);
}
