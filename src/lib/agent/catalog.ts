import i18n from "@/i18n";
import { invokeApi } from "@/lib/agent/invoke";
import type {
	AgentDescriptor,
	AgentListResponse,
	AgentSkill,
	AgentTemplate,
	AgentTemplateInfo,
	CatalogAcpStatus,
	CatalogScanResponse,
	ProbeResult,
} from "@/lib/agent/types";

export async function listAgents(): Promise<AgentListResponse> {
	return invokeApi("agent_list_agents");
}

export async function listTemplates(): Promise<AgentTemplateInfo[]> {
	const res = await invokeApi<{ templates: AgentTemplateInfo[] }>(
		"agent_list_templates",
	);
	return res.templates;
}

export async function listAgentSkills(
	vaultPath?: string,
): Promise<AgentSkill[]> {
	return invokeApi("agent_list_skills", { vaultPath: vaultPath ?? null });
}

export async function scanCatalog(): Promise<CatalogScanResponse> {
	return invokeApi("agent_scan_catalog");
}

export async function upsertAgent(request: {
	id?: string;
	name: string;
	template?: AgentTemplate;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	setDefault?: boolean;
}): Promise<AgentDescriptor> {
	const res = await invokeApi<{ agent: AgentDescriptor }>(
		"agent_upsert_agent",
		{
			request,
		},
	);
	return res.agent;
}

export async function ensureCatalogAgent(
	templateId: string,
	setDefault = false,
): Promise<AgentDescriptor> {
	const res = await invokeApi<{ agent: AgentDescriptor }>(
		"agent_ensure_catalog",
		{ templateId, setDefault },
	);
	return res.agent;
}

export async function removeAgent(id: string): Promise<void> {
	await invokeApi("agent_remove_agent", { id });
}

export async function setDefaultAgent(
	id: string | null,
): Promise<AgentListResponse> {
	return invokeApi("agent_set_default", { id });
}

export async function setAgentEnabled(enabled: boolean): Promise<boolean> {
	const res = await invokeApi<{ enabled: boolean }>("agent_set_enabled", {
		enabled,
	});
	return res.enabled;
}

export async function setAgentProxy(
	proxyEnabled: boolean,
	proxyUrl: string,
): Promise<{ proxyEnabled: boolean; proxyUrl: string }> {
	return invokeApi("agent_set_proxy", { proxyEnabled, proxyUrl });
}

export async function discoverAgents(id?: string): Promise<AgentListResponse> {
	return invokeApi("agent_discover", { id: id ?? null });
}

export async function probeAgent(id: string): Promise<ProbeResult> {
	return invokeApi("agent_probe", { id });
}

export async function probeCatalogAgent(
	templateId: string,
): Promise<ProbeResult> {
	return invokeApi("agent_probe_catalog", { templateId });
}

/**
 * Open the system terminal with the template's install command and wait for
 * the user to confirm (Enter) before running. Host only allows known templates.
 */
export async function openInstallTerminal(templateId: string): Promise<void> {
	await invokeApi("agent_open_install_terminal", { templateId });
}

export function acpStatusLabel(status: CatalogAcpStatus): string {
	switch (status) {
		case "ready":
			return i18n.t("agent:acpStatus.ready");
		case "failed":
			return i18n.t("agent:acpStatus.failed");
		case "not-probed":
			return i18n.t("agent:acpStatus.notProbed");
		case "missing":
			return i18n.t("agent:acpStatus.notInstalled");
	}
}
