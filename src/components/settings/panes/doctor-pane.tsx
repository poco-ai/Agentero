import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageTitle } from "@/components/settings/settings-layout";
import type { SettingsHostContext } from "@/components/settings/types";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import {
	type AgentAcpDiagnostic,
	type DoctorReport,
	doctorCheck,
	doctorCheckAgents,
	doctorCheckHost,
	doctorCheckNetwork,
	doctorOpenAgentLoginTerminal,
	type HostDoctorReport,
	type NetworkDoctorReport,
} from "@/lib/doctor/api";
import { DoctorAgentSection } from "./doctor-agent-section";
import { DoctorAliasSection } from "./doctor-alias-section";
import { DoctorBackfillSection } from "./doctor-backfill-section";
import { DoctorHostRuntimeSection } from "./doctor-host-runtime-section";
import { DoctorNetworkSection } from "./doctor-network-section";
import {
	DoctorCatalogSection,
	DoctorVaultSection,
} from "./doctor-vault-catalog-sections";
import { DoctorVisualMarksSection } from "./doctor-visual-marks-section";
import { DoctorWikilinkSection } from "./doctor-wikilink-section";

export function DoctorPane({
	vaultPath,
	hostContext,
}: {
	vaultPath?: string | null;
	hostContext: SettingsHostContext;
}) {
	const { t } = useTranslation("settings");
	const [report, setReport] = useState<DoctorReport | null>(null);
	const [hostReport, setHostReport] = useState<HostDoctorReport | null>(null);
	const [networkReport, setNetworkReport] =
		useState<NetworkDoctorReport | null>(null);
	const [agentReport, setAgentReport] = useState<AgentAcpDiagnostic[] | null>(
		null,
	);
	const [hostError, setHostError] = useState<string | null>(null);
	const [networkError, setNetworkError] = useState<string | null>(null);
	const [agentError, setAgentError] = useState<string | null>(null);
	const [vaultError, setVaultError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	// Start true for local so the first paint shows shimmer instead of "none".
	const [agentsLoading, setAgentsLoading] = useState(
		() => hostContext.kind !== "remote",
	);
	const [networkLoading, setNetworkLoading] = useState(
		() => hostContext.kind !== "remote",
	);
	const [wikiPlanning, setWikiPlanning] = useState(false);

	const refresh = useCallback(async () => {
		if (hostContext.kind === "remote") return;
		setLoading(true);
		setHostError(null);
		setVaultError(null);
		try {
			try {
				setHostReport(await doctorCheckHost());
			} catch (error) {
				setHostError(errorText(error));
			}
			if (vaultPath) {
				try {
					setReport(await doctorCheck(vaultPath));
				} catch (error) {
					setVaultError(errorText(error));
				}
			}
		} finally {
			setLoading(false);
		}
	}, [hostContext.kind, vaultPath]);

	// ACP re-probes can take ~30s per agent, so they load independently of the
	// fast host/vault checks above.
	const refreshAgents = useCallback(async () => {
		if (hostContext.kind === "remote") return;
		setAgentsLoading(true);
		setAgentError(null);
		try {
			setAgentReport(await doctorCheckAgents());
		} catch (error) {
			setAgentError(errorText(error));
		} finally {
			setAgentsLoading(false);
		}
	}, [hostContext.kind]);

	const refreshAgentsAfterLogin = useCallback(() => {
		for (const delay of [2_000, 5_000, 10_000, 20_000]) {
			window.setTimeout(() => {
				void refreshAgents();
			}, delay);
		}
	}, [refreshAgents]);

	const openAgentLogin = useCallback(
		async (templateId: string) => {
			try {
				await doctorOpenAgentLoginTerminal(templateId);
				refreshAgentsAfterLogin();
			} catch (error) {
				setAgentError(errorText(error));
			}
		},
		[refreshAgentsAfterLogin],
	);

	// Network probes can take up to the timeout per host, so they also load
	// independently of the fast host/vault checks.
	const refreshNetwork = useCallback(async () => {
		if (hostContext.kind === "remote") return;
		setNetworkLoading(true);
		setNetworkError(null);
		try {
			setNetworkReport(await doctorCheckNetwork());
		} catch (error) {
			setNetworkError(errorText(error));
		} finally {
			setNetworkLoading(false);
		}
	}, [hostContext.kind]);

	useEffect(() => {
		void refresh();
		void refreshAgents();
		void refreshNetwork();
	}, [refresh, refreshAgents, refreshNetwork]);

	if (hostContext.kind === "remote") {
		return (
			<>
				<PageTitle title={t("doctor.title")} />
				<p className="rounded-xl border bg-muted/30 px-4 py-3 text-muted-foreground text-sm">
					{t("doctor.remoteUnavailable")}
				</p>
			</>
		);
	}
	const catalogIssues = report?.catalog.issues ?? [];
	const hasCatalogDuplicates =
		(report?.catalog.duplicateReport?.duplicateIds.length ?? 0) > 0 ||
		(report?.catalog.duplicateReport?.duplicatePaths.length ?? 0) > 0;

	return (
		<>
			<PageTitle
				title={t("doctor.title")}
				actions={
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label={t("doctor.refresh")}
								disabled={
									loading || wikiPlanning || agentsLoading || networkLoading
								}
								onClick={() => {
									void refresh();
									void refreshAgents();
									void refreshNetwork();
								}}
							>
								<RefreshCw className={loading ? "animate-spin" : undefined} />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("doctor.refresh")}</TooltipContent>
					</Tooltip>
				}
			/>

			{vaultPath && (
				<DoctorBackfillSection key={vaultPath} vaultPath={vaultPath} />
			)}

			<DoctorHostRuntimeSection
				report={hostReport}
				error={hostError}
				onRefresh={refresh}
			/>

			<DoctorNetworkSection
				report={networkReport}
				loading={networkLoading}
				error={networkError}
			/>

			<DoctorAgentSection
				report={agentReport}
				loading={agentsLoading}
				error={agentError}
				onLogin={openAgentLogin}
			/>

			{vaultPath ? (
				vaultError ? (
					<p className="rounded-xl border bg-card px-3.5 py-2.5 text-amber-700 text-xs">
						{vaultError}
					</p>
				) : (
					<>
						<DoctorVaultSection
							ok={report?.vault.ok ?? true}
							issues={report?.vault.issues ?? []}
						/>

						<DoctorCatalogSection
							vaultPath={vaultPath}
							ok={report?.catalog.ok ?? true}
							issues={catalogIssues}
							hasDuplicates={hasCatalogDuplicates}
							onRefresh={refresh}
						/>

						<DoctorWikilinkSection
							vaultPath={vaultPath}
							wikilinks={report?.wikilinks}
							planning={wikiPlanning}
							onPlanningChange={setWikiPlanning}
							onRefresh={refresh}
						/>

						<DoctorAliasSection
							vaultPath={vaultPath}
							aliases={report?.aliases}
							onRefresh={refresh}
						/>

						<DoctorVisualMarksSection
							vaultPath={vaultPath}
							visualMarks={report?.visualMarks}
							onRefresh={refresh}
						/>
					</>
				)
			) : (
				<p className="rounded-xl border bg-muted/30 px-4 py-3 text-muted-foreground text-sm">
					{t("doctor.openVault")}
				</p>
			)}
		</>
	);
}
