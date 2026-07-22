//! Pure helpers for the Settings agent panes: probe-cache keys, probe-needed
//! predicates, immutable scan patches, status tone, and byte formatting.
//! Extracted from `settings-window.tsx` for unit testing. The `patch*`
//! functions accept an injectable `now` timestamp so tests stay deterministic.

import type {
	CatalogEntry,
	CatalogScanResponse,
	ProbeResult,
} from "@/lib/agent";

export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0 B";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
	if (!(entry.binaryAvailable || entry.acpCommandAvailable)) return false;
	if (force) return true;
	return entry.acpStatus === "not-probed" || entry.acpStatus === "failed";
}

export function patchCatalogProbe(
	scan: CatalogScanResponse,
	templateId: string,
	result: ProbeResult,
	now: string = new Date().toISOString(),
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
				lastProbedAt: now,
			};
		}),
	};
}

export function patchCustomProbe(
	scan: CatalogScanResponse,
	agentId: string,
	result: ProbeResult,
	now: string = new Date().toISOString(),
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
				lastProbedAt: now,
			};
		}),
	};
}

export function catalogStatusTone(
	status: CatalogEntry["acpStatus"],
): "ok" | "warn" | "err" | "muted" {
	switch (status) {
		case "ready":
			return "ok";
		case "failed":
			return "err";
		case "not-probed":
			return "warn";
		case "missing":
			return "muted";
	}
}
