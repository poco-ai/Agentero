import { describe, expect, it } from "vitest";
import type {
	CatalogEntry,
	CatalogScanResponse,
	ProbeResult,
} from "@/lib/agent";
import {
	catalogNeedsProbe,
	catalogProbeKey,
	catalogStatusTone,
	customProbeKey,
	formatBytes,
	patchCatalogProbe,
	patchCustomProbe,
} from "@/lib/settings-probe";

describe("formatBytes", () => {
	it("formats across unit boundaries and guards bad input", () => {
		expect(formatBytes(-1)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
		expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
	});
});

describe("probe cache keys", () => {
	it("namespaces catalog vs custom", () => {
		expect(catalogProbeKey("claude")).toBe("catalog:claude");
		expect(customProbeKey("a1")).toBe("custom:a1");
	});
});

describe("catalogNeedsProbe", () => {
	const base = {
		binaryAvailable: true,
		acpCommandAvailable: false,
	} as CatalogEntry;
	it("skips when neither binary nor command available", () => {
		expect(
			catalogNeedsProbe(
				{
					...base,
					binaryAvailable: false,
					acpStatus: "not-probed",
				} as CatalogEntry,
				true,
			),
		).toBe(false);
	});
	it("forces regardless of status when available", () => {
		expect(
			catalogNeedsProbe({ ...base, acpStatus: "ready" } as CatalogEntry, true),
		).toBe(true);
	});
	it("probes not-probed/failed on soft open", () => {
		expect(
			catalogNeedsProbe(
				{ ...base, acpStatus: "not-probed" } as CatalogEntry,
				false,
			),
		).toBe(true);
		expect(
			catalogNeedsProbe({ ...base, acpStatus: "ready" } as CatalogEntry, false),
		).toBe(false);
	});
});

describe("catalogStatusTone", () => {
	it("maps status to tone", () => {
		expect(catalogStatusTone("ready")).toBe("ok");
		expect(catalogStatusTone("failed")).toBe("err");
		expect(catalogStatusTone("not-probed")).toBe("warn");
		expect(catalogStatusTone("missing")).toBe("muted");
	});
});

describe("patch probes (deterministic clock)", () => {
	const NOW = "2026-07-22T00:00:00.000Z";
	it("patches only the matching catalog entry", () => {
		const scan = {
			entries: [
				{ templateId: "claude", registeredId: null, acpStatus: "not-probed" },
				{ templateId: "codex", registeredId: "x", acpStatus: "ready" },
			],
			customAgents: [],
		} as unknown as CatalogScanResponse;
		const result = {
			agentId: "a1",
			available: true,
			agentName: "Claude",
			error: null,
		} as ProbeResult;
		const out = patchCatalogProbe(scan, "claude", result, NOW);
		expect(out.entries[0]).toMatchObject({
			acpStatus: "ready",
			registeredId: "a1",
			lastProbedAt: NOW,
		});
		expect(out.entries[1]).toBe(scan.entries[1]); // untouched reference
	});

	it("patches only the matching custom agent", () => {
		const scan = {
			entries: [],
			customAgents: [
				{ id: "a1", available: false },
				{ id: "a2", available: true },
			],
		} as unknown as CatalogScanResponse;
		const result = {
			agentId: "a1",
			available: false,
			agentName: null,
			error: "boom",
		} as ProbeResult;
		const out = patchCustomProbe(scan, "a1", result, NOW);
		expect(out.customAgents[0]).toMatchObject({
			lastProbeOk: false,
			lastProbeError: "boom",
			lastProbedAt: NOW,
		});
		expect(out.customAgents[1]).toBe(scan.customAgents[1]);
	});
});
