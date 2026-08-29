import { ArrowUpCircle, Loader2, Terminal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import type { UninstallTarget } from "@/components/settings/panes/agent/use-agent-uninstall";
import {
	catalogProbeKey,
	catalogStatusTone,
	customProbeKey,
	isCatalogEntryProbing,
	isCustomAgentProbing,
	ProbingBadge,
	StatusBadge,
	showInstallAcp,
	showInstallAgent,
	showUninstallAgent,
	showUpdateAgent,
} from "@/components/settings/panes/agent-catalog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { useAgentToolLifecycle } from "@/hooks/use-agent-tool-lifecycle";
import {
	type AgentDescriptor,
	acpStatusLabel,
	type CatalogEntry,
	type CatalogScanResponse,
	isAgentAuthFailure,
} from "@/lib/agent";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";

type AgentToolLifecycle = ReturnType<typeof useAgentToolLifecycle>;

export function AgentCatalogRows({
	catalog,
	loading,
	probingKeys,
	lifecycle,
	openUninstallDialog,
}: {
	catalog: CatalogScanResponse | null;
	/** Global scan busy — ProbingBadge inference needs it next to probingKeys. */
	loading: boolean;
	probingKeys: ReadonlySet<string>;
	lifecycle: AgentToolLifecycle;
	openUninstallDialog: (target: UninstallTarget) => void;
}) {
	const { t } = useTranslation(["settings", "agent", "common"]);
	const entries = catalog?.entries ?? [];
	const customAgents = catalog?.customAgents ?? [];
	// A scan or any in-flight probe marks not-probed rows as "probing".
	const batchActive = loading || probingKeys.size > 0;

	return (
		<>
			{entries.length === 0 && loading ? (
				<div className="flex items-center gap-2 px-3.5 py-4 text-muted-foreground text-xs">
					<Loader2 className="size-3.5 animate-spin" aria-hidden />
					{t("agent.scanning")}
				</div>
			) : null}
			{entries.map((entry) => (
				<AgentCatalogEntryRow
					key={entry.templateId}
					entry={entry}
					probing={probingKeys.has(catalogProbeKey(entry.templateId))}
					batchActive={batchActive}
					lifecycle={lifecycle}
					openUninstallDialog={openUninstallDialog}
				/>
			))}
			{customAgents.map((agent) => (
				<AgentCustomAgentRow
					key={agent.id}
					agent={agent}
					isDefault={catalog?.defaultId === agent.id}
					probing={probingKeys.has(customProbeKey(agent.id))}
					batchActive={batchActive}
					openUninstallDialog={openUninstallDialog}
				/>
			))}
		</>
	);
}

function AgentCatalogEntryRow({
	entry,
	probing,
	batchActive,
	lifecycle,
	openUninstallDialog,
}: {
	entry: CatalogEntry;
	probing: boolean;
	batchActive: boolean;
	lifecycle: AgentToolLifecycle;
	openUninstallDialog: (target: UninstallTarget) => void;
}) {
	const { t } = useTranslation(["settings", "agent", "common"]);
	const { lifecycleBusyIds, lifecycleProgress, runToolLifecycle } = lifecycle;
	const installAgent = showInstallAgent(entry);
	const installAcp = showInstallAcp(entry);
	const updateAgent = showUpdateAgent(entry);
	const uninstallAgent = showUninstallAgent(entry);
	// Install/ACP-only gaps gate “Use default”; Update/Uninstall can sit beside it.
	const needsInstall = installAgent || installAcp;
	const hasLifecycleAction = needsInstall || updateAgent || uninstallAgent;
	const notInstalled = !entry.binaryAvailable;
	const rowInstalling = lifecycleBusyIds.has(entry.templateId);
	const rowBusyAction = lifecycleBusyIds.get(entry.templateId);
	const rowLifecycle = lifecycleProgress[entry.templateId];
	const isProbing = isCatalogEntryProbing(entry, probing, batchActive);
	return (
		<div className="flex flex-col gap-2 border-b py-2.5 pr-1.5 pl-3.5 last:border-b-0">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 flex-1 items-center gap-4">
					<div className="flex w-32 shrink-0 items-center gap-2">
						<AgentLogo template={entry.templateId} />
						<span
							className={cn(
								"min-w-0 truncate font-medium text-[13px]",
								// Dim label only — never the Install button (looks disabled).
								notInstalled &&
									!hasLifecycleAction &&
									"text-muted-foreground opacity-50",
								notInstalled && hasLifecycleAction && "text-muted-foreground",
							)}
						>
							{entry.name}
						</span>
					</div>
					<div className="flex min-w-0 flex-wrap items-center gap-1.5">
						{entry.isDefault ? (
							<StatusBadge tone="primary">
								{t("agent.badges.default")}
							</StatusBadge>
						) : null}
						{/* Layer 1: Agent host CLI */}
						{entry.binaryAvailable ? (
							<StatusBadge tone="ok" title={entry.resolvedPath ?? undefined}>
								{t("agent.badges.agentInstalled")}
							</StatusBadge>
						) : (
							<StatusBadge tone="muted">
								{t("agent.badges.agentMissing")}
							</StatusBadge>
						)}
						{/* Layer 2: ACP entrypoint / probe */}
						{!entry.acpCommandAvailable ? (
							<StatusBadge
								tone={entry.binaryAvailable ? "warn" : "muted"}
								title={entry.lastProbeError ?? entry.installHint ?? undefined}
							>
								{t("agent.badges.acpMissing")}
							</StatusBadge>
						) : isProbing ? (
							<ProbingBadge label={t("agent.probing")} />
						) : (
							<StatusBadge
								tone={catalogStatusTone(entry.acpStatus, entry.lastProbeError)}
								title={entry.lastProbeError ?? entry.acpAgentName ?? undefined}
							>
								{acpStatusLabel(entry.acpStatus, entry.lastProbeError)}
							</StatusBadge>
						)}
					</div>
				</div>
				{/* Fixed action slot so icon-only rows align with “Use default” */}
				<div
					className={cn(
						"flex h-7 shrink-0 items-center justify-center gap-1",
						hasLifecycleAction ? "min-w-0" : "w-8",
					)}
				>
					{installAgent ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 gap-1 px-2 text-xs"
							aria-label={t("agent.installAgentAria", {
								name: entry.name,
							})}
							title={t("agent.installAgentTitle")}
							// Do not gate on global `busy` (catalog scan/ACP probe of
							// other agents) — that left Install looking dead for minutes.
							disabled={rowInstalling || !isTauri()}
							onClick={() => void runToolLifecycle(entry, "install")}
						>
							{rowBusyAction === "install" ? (
								<Loader2 className="size-3 animate-spin" />
							) : (
								<Terminal className="size-3" />
							)}
							{t("agent.installAgent")}
						</Button>
					) : null}
					{installAcp ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 gap-1 px-2 text-xs"
							aria-label={t("agent.installAdapterAria", {
								name: entry.name,
							})}
							title={t("agent.installAdapterTitle")}
							disabled={rowInstalling || !isTauri()}
							onClick={() => void runToolLifecycle(entry, "install")}
						>
							{rowBusyAction === "install" ? (
								<Loader2 className="size-3 animate-spin" />
							) : (
								<Terminal className="size-3" />
							)}
							{t("agent.installAdapter")}
						</Button>
					) : null}
					{updateAgent ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 gap-1 px-2 text-xs"
							aria-label={t("agent.updateAgentAria", {
								name: entry.name,
							})}
							title={t("agent.updateAgentTitle")}
							disabled={rowInstalling || !isTauri()}
							onClick={() => void runToolLifecycle(entry, "update")}
						>
							{rowBusyAction === "update" ? (
								<Loader2 className="size-3 animate-spin" />
							) : (
								<ArrowUpCircle className="size-3" />
							)}
							{t("agent.updateAgent")}
						</Button>
					) : null}
					{uninstallAgent ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="size-7"
							aria-label={t("agent.uninstallAgentAria", {
								name: entry.name,
							})}
							title={t("agent.uninstallAgentTitle")}
							disabled={rowInstalling || !isTauri()}
							onClick={() =>
								openUninstallDialog({
									kind: "catalog",
									entry,
									info: null,
								})
							}
						>
							{rowBusyAction === "uninstall" ? (
								<Loader2
									className="size-3.5 animate-spin text-destructive"
									aria-hidden
								/>
							) : (
								<Trash2 className="size-3.5 text-destructive" aria-hidden />
							)}
						</Button>
					) : null}
				</div>
			</div>
			{rowLifecycle ? (
				<div className="grid grid-cols-[8rem_minmax(0,1fr)_2.5rem] items-center gap-3 pr-2">
					<span className="truncate text-[11px] text-muted-foreground">
						{rowLifecycle.detail}
					</span>
					<Progress value={rowLifecycle.progress ?? 0} className="h-1" />
					<span className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
						{rowLifecycle.progress == null
							? ""
							: `${Math.round(rowLifecycle.progress)}%`}
					</span>
				</div>
			) : null}
		</div>
	);
}

function AgentCustomAgentRow({
	agent,
	isDefault,
	probing,
	batchActive,
	openUninstallDialog,
}: {
	agent: AgentDescriptor;
	isDefault: boolean;
	probing: boolean;
	batchActive: boolean;
	openUninstallDialog: (target: UninstallTarget) => void;
}) {
	const { t } = useTranslation(["settings", "agent", "common"]);
	const isProbing = isCustomAgentProbing(agent, probing, batchActive);
	return (
		<div className="flex items-center justify-between gap-3 border-b py-2.5 pr-1.5 pl-3.5 last:border-b-0">
			<div className="flex min-w-0 flex-1 items-center gap-4">
				<div className="flex w-32 shrink-0 items-center gap-2">
					<AgentLogo template={agent.template} />
					<span className="min-w-0 truncate font-medium text-[13px]">
						{agent.name}
					</span>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
					{isDefault ? (
						<StatusBadge tone="primary">
							{t("agent.badges.default")}
						</StatusBadge>
					) : null}
					{isProbing ? (
						<ProbingBadge label={t("agent.probing")} />
					) : agent.lastProbeOk === true ? (
						<StatusBadge tone="ok">{t("agent:acpStatus.ready")}</StatusBadge>
					) : agent.lastProbeOk === false ? (
						<StatusBadge
							tone={isAgentAuthFailure(agent.lastProbeError) ? "warn" : "err"}
							title={agent.lastProbeError ?? undefined}
						>
							{isAgentAuthFailure(agent.lastProbeError)
								? t("agent:acpStatus.notLoggedIn")
								: t("agent:acpStatus.failed")}
						</StatusBadge>
					) : agent.available ? (
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
					title={t("common:remove")}
					disabled={!isTauri()}
					onClick={() =>
						openUninstallDialog({
							kind: "custom",
							id: agent.id,
							name: agent.name,
							template: agent.template,
						})
					}
				>
					<Trash2 className="size-3.5 text-destructive" aria-hidden />
				</Button>
			</div>
		</div>
	);
}

/** Remote catalog row: guided terminal ACP install only (no silent host install). */
export function RemoteAgentCatalogRow({
	entry,
	hostLabel,
	probing,
	batchActive,
	busy,
	onInstall,
}: {
	entry: CatalogEntry;
	/** SSH host label for the install-command tooltip. */
	hostLabel: string;
	probing: boolean;
	batchActive: boolean;
	busy: boolean;
	onInstall: (entry: CatalogEntry) => void;
}) {
	const { t } = useTranslation(["settings", "agent", "common"]);
	const installAcp = Boolean(entry.offerInstall);
	const notInstalled = !entry.binaryAvailable;
	const isProbing = isCatalogEntryProbing(entry, probing, batchActive);
	return (
		<div className="flex items-center justify-between gap-3 border-b py-2.5 pr-1.5 pl-3.5 last:border-b-0">
			<div className="flex min-w-0 flex-1 items-center gap-4">
				<div className="flex w-32 shrink-0 items-center gap-2">
					<AgentLogo template={entry.templateId} />
					<span
						className={cn(
							"min-w-0 truncate font-medium text-[13px]",
							notInstalled && "text-muted-foreground",
							notInstalled && !installAcp && "opacity-50",
						)}
						title={entry.lastProbeError || entry.description || entry.name}
					>
						{entry.name}
					</span>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
					{entry.binaryAvailable ? (
						<StatusBadge tone="ok" title={entry.resolvedPath ?? undefined}>
							{t("agent.badges.agentInstalled")}
						</StatusBadge>
					) : (
						<StatusBadge tone="muted">
							{t("agent.badges.agentMissing")}
						</StatusBadge>
					)}
					{!entry.acpCommandAvailable ? (
						<StatusBadge
							tone={entry.binaryAvailable ? "warn" : "muted"}
							title={entry.lastProbeError ?? undefined}
						>
							{t("agent.badges.acpMissing")}
						</StatusBadge>
					) : isProbing ? (
						<ProbingBadge label={t("agent.probing")} />
					) : (
						<StatusBadge
							tone={catalogStatusTone(entry.acpStatus, entry.lastProbeError)}
							title={entry.lastProbeError ?? entry.acpAgentName ?? undefined}
						>
							{acpStatusLabel(entry.acpStatus, entry.lastProbeError)}
						</StatusBadge>
					)}
				</div>
			</div>
			<div
				className={cn(
					"flex h-7 shrink-0 items-center justify-center gap-1",
					installAcp ? "min-w-0" : "w-8",
				)}
			>
				{installAcp ? (
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
										host: hostLabel,
									})
								: t("agent.installAdapter")
						}
						disabled={busy || !isTauri()}
						onClick={() => onInstall(entry)}
					>
						<Terminal className="size-3" />
						{t("agent.installAdapter")}
					</Button>
				) : null}
			</div>
		</div>
	);
}
