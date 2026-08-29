import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type {
	AgentDescriptor,
	AgentTemplate,
	CatalogEntry,
	CatalogScanResponse,
	ProbeResult,
} from "@/lib/agent";
import { isAgentAuthFailure } from "@/lib/agent";
import { cn } from "@/lib/core/utils";

export function StatusBadge({
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
export function ProbingBadge({ label }: { label: string }) {
	return (
		<StatusBadge tone="warn">
			<Loader2 className="size-2.5 shrink-0 animate-spin" aria-hidden />
			{label}
		</StatusBadge>
	);
}

export function catalogProbeKey(templateId: string): string {
	return `catalog:${templateId}`;
}

export function customProbeKey(id: string): string {
	return `custom:${id}`;
}

/** Whether a catalog row still needs ACP initialize (skip already-ready on soft open). */
export function catalogNeedsProbe(
	entry: CatalogEntry,
	force: boolean,
): boolean {
	// Only probe when the ACP entrypoint exists (not merely host CLI).
	if (!entry.acpCommandAvailable) return false;
	if (force) return true;
	return entry.acpStatus === "not-probed" || entry.acpStatus === "failed";
}

/**
 * Row badge is "probing": its own probe key is in flight, or the host cleared a
 * not-probed status while a batch (scan / any probe) is running.
 */
export function isCatalogEntryProbing(
	entry: CatalogEntry,
	rowProbing: boolean,
	batchActive: boolean,
): boolean {
	return (
		rowProbing ||
		(entry.acpCommandAvailable &&
			entry.acpStatus === "not-probed" &&
			batchActive)
	);
}

/** Same inference for custom agents (available but never probed + batch running). */
export function isCustomAgentProbing(
	agent: AgentDescriptor,
	rowProbing: boolean,
	batchActive: boolean,
): boolean {
	const notProbedYet = agent.available && agent.lastProbeOk == null;
	return rowProbing || (notProbedYet && batchActive);
}

/** Local silent install of the host Agent CLI (and adapter when needed). */
export function showInstallAgent(entry: CatalogEntry): boolean {
	return Boolean(entry.canInstall) && !entry.binaryAvailable;
}

/**
 * Host CLI present but ACP entrypoint missing — install adapter / ACP mode only.
 * For native-ACP agents (detect === command), host missing is handled by Install Agent.
 */
export function showInstallAcp(entry: CatalogEntry): boolean {
	if (!entry.binaryAvailable || entry.acpCommandAvailable) return false;
	return Boolean(entry.offerInstall || entry.canInstall);
}

/** Host CLI already on PATH — silent upgrade via `runToolLifecycle(..., "update")`. */
export function showUpdateAgent(entry: CatalogEntry): boolean {
	return Boolean(entry.canInstall) && entry.binaryAvailable;
}

/**
 * Row can be uninstalled/removed: a registry entry always qualifies; otherwise
 * an installed CLI of a lifecycle template (excludes plain-PATH templates like
 * qodercli that we never installed).
 */
export function showUninstallAgent(entry: CatalogEntry): boolean {
	return (
		Boolean(entry.registeredId) ||
		(Boolean(entry.canInstall) && entry.binaryAvailable)
	);
}

export const NO_DEFAULT_AGENT_CHOICE = "__no_default_agent__";

export type DefaultAgentChoice = {
	value: string;
	name: string;
	template: AgentTemplate;
	source: "catalog" | "custom";
	templateId?: string;
	agentId?: string;
	isDefault: boolean;
};

function catalogTemplateFromId(templateId: string): AgentTemplate {
	switch (templateId) {
		case "opencode":
		case "openclaw":
		case "gemini":
		case "hermes":
		case "claude-acp":
		case "codex-acp":
		case "qodercli":
		case "grok-build":
		case "pi":
		case "dsh":
		case "kimi-code":
			return templateId;
		default:
			return "custom";
	}
}

export function buildDefaultAgentChoices(
	scan: CatalogScanResponse | null | undefined,
): DefaultAgentChoice[] {
	if (!scan) return [];
	const choices: DefaultAgentChoice[] = [];
	const seenAgentIds = new Set<string>();

	for (const entry of scan.entries) {
		const needsInstall = showInstallAgent(entry) || showInstallAcp(entry);
		const canUse =
			(entry.acpCommandAvailable || entry.acpStatus === "ready") &&
			!needsInstall;
		if (!canUse) continue;
		if (entry.registeredId) seenAgentIds.add(entry.registeredId);
		choices.push({
			value: `catalog:${entry.templateId}`,
			name: entry.name,
			template: catalogTemplateFromId(entry.templateId),
			source: "catalog",
			templateId: entry.templateId,
			agentId: entry.registeredId ?? undefined,
			isDefault: entry.isDefault,
		});
	}

	for (const agent of scan.customAgents) {
		if (!agent.available && agent.lastProbeOk !== true) continue;
		if (seenAgentIds.has(agent.id)) continue;
		seenAgentIds.add(agent.id);
		choices.push({
			value: `custom:${agent.id}`,
			name: agent.name,
			template: agent.template,
			source: "custom",
			agentId: agent.id,
			isDefault: scan.defaultId === agent.id,
		});
	}

	return choices;
}

export function defaultAgentChoiceValue(
	scan: CatalogScanResponse | null | undefined,
	choices: DefaultAgentChoice[],
): string {
	const current =
		choices.find((choice) => choice.isDefault) ??
		choices.find(
			(choice) => choice.agentId && choice.agentId === scan?.defaultId,
		);
	return current?.value ?? NO_DEFAULT_AGENT_CHOICE;
}

export function patchCatalogProbe(
	scan: CatalogScanResponse,
	templateId: string,
	result: ProbeResult,
): CatalogScanResponse {
	return {
		...scan,
		entries: scan.entries.map((entry) => {
			if (entry.templateId !== templateId) return entry;
			return {
				...entry,
				registeredId: entry.registeredId ?? result.agentId,
				acpStatus: result.available ? "ready" : "failed",
				acpAgentName: result.agentName ?? null,
				lastProbeError: result.error ?? null,
				lastProbedAt: new Date().toISOString(),
			};
		}),
	};
}

export function patchCustomProbe(
	scan: CatalogScanResponse,
	agentId: string,
	result: ProbeResult,
): CatalogScanResponse {
	return {
		...scan,
		customAgents: scan.customAgents.map((agent) => {
			if (agent.id !== agentId) return agent;
			return {
				...agent,
				available: result.available ? true : agent.available,
				lastProbeOk: result.available,
				lastProbeAgentName: result.agentName ?? null,
				lastProbeError: result.error ?? null,
				lastProbedAt: new Date().toISOString(),
			};
		}),
	};
}

export function catalogStatusTone(
	status: CatalogEntry["acpStatus"],
	error?: string | null,
): "ok" | "warn" | "err" | "muted" {
	switch (status) {
		case "ready":
			return "ok";
		case "failed":
			if (isAgentAuthFailure(error)) return "warn";
			return "err";
		case "not-probed":
			return "warn";
		case "missing":
			return "muted";
	}
}

/** Availability icon for free-MT providers in the default-service Select. */
