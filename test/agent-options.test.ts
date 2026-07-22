import { describe, expect, it } from "vitest";
import type { AgentListResponse, CatalogScanResponse } from "@/lib/agent";
import {
	buildOptions,
	catalogEntryUsable,
	isBackgroundWorkflowHistoryTitle,
	registryAgentUsable,
	resolveSelected,
	SUGGESTION_KEYS,
	SUGGESTION_WORKFLOW,
} from "@/lib/agent-options";

describe("usability predicates", () => {
	it("catalog entry is usable only when acp handshake ready", () => {
		expect(
			catalogEntryUsable({
				acpStatus: "ready",
				binaryAvailable: true,
				acpCommandAvailable: true,
			}),
		).toBe(true);
		expect(
			catalogEntryUsable({
				acpStatus: "missing",
				binaryAvailable: true,
				acpCommandAvailable: true,
			}),
		).toBe(false);
	});

	it("registry agent usable via available or last probe ok", () => {
		expect(registryAgentUsable({ available: false, lastProbeOk: true })).toBe(
			true,
		);
		expect(registryAgentUsable({ available: false, lastProbeOk: false })).toBe(
			false,
		);
		expect(registryAgentUsable({ available: true })).toBe(true);
	});
});

describe("buildOptions", () => {
	it("omits unavailable backends and dedupes ids across sources", () => {
		const catalog = {
			entries: [
				{
					templateId: "claude",
					name: "Claude",
					acpStatus: "ready",
					binaryAvailable: true,
					acpCommandAvailable: true,
					registeredId: "a1",
					isDefault: true,
				},
				{
					templateId: "codex",
					name: "Codex",
					acpStatus: "missing",
					binaryAvailable: false,
					acpCommandAvailable: false,
					registeredId: null,
					isDefault: false,
				},
			],
			customAgents: [{ id: "a1", name: "Claude dup", available: true }],
			defaultId: "a1",
		} as unknown as CatalogScanResponse;
		const registry = {
			agents: [{ id: "a2", name: "Local", available: true }],
			defaultId: "a1",
		} as unknown as AgentListResponse;

		const opts = buildOptions(registry, catalog);
		expect(opts.map((o) => o.name)).toEqual(["Claude", "Local"]); // codex omitted, a1 deduped
		expect(opts.find((o) => o.id === "a1")?.isDefault).toBe(true);
	});
});

describe("resolveSelected", () => {
	const opts = [
		{
			key: "k1",
			id: "a1",
			templateId: null,
			name: "A",
			available: true,
			isDefault: false,
			source: "registry" as const,
		},
		{
			key: "k2",
			id: "a2",
			templateId: null,
			name: "B",
			available: true,
			isDefault: true,
			source: "registry" as const,
		},
	];
	it("prefers explicit selection, then default, then first", () => {
		expect(resolveSelected(opts, "a1", null)?.id).toBe("a1");
		expect(resolveSelected(opts, null, null)?.id).toBe("a2"); // isDefault
		expect(resolveSelected(opts, "missing", null)?.id).toBe("a2"); // falls to default
		expect(resolveSelected([], null, null)).toBeUndefined();
	});
});

describe("isBackgroundWorkflowHistoryTitle", () => {
	it("hides paper-reader / lecture-note runs", () => {
		expect(isBackgroundWorkflowHistoryTitle("Agentero paper-reader run")).toBe(
			true,
		);
		expect(
			isBackgroundWorkflowHistoryTitle("Write structured lecture notes"),
		).toBe(true);
		expect(isBackgroundWorkflowHistoryTitle("Summarize this paper")).toBe(
			false,
		);
	});
});

describe("suggestion tables", () => {
	it("every suggestion key maps to a workflow", () => {
		for (const key of SUGGESTION_KEYS) {
			expect(typeof SUGGESTION_WORKFLOW[key]).toBe("string");
		}
	});
});
