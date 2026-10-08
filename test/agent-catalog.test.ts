import { describe, expect, it } from "vitest";
import {
	buildDefaultAgentChoices,
	defaultAgentChoiceValue,
	NO_DEFAULT_AGENT_CHOICE,
	patchCatalogProbe,
	showUninstallAgent,
	showUpdateAgent,
} from "@/components/settings/panes/agent-catalog";
import type {
	AgentDescriptor,
	CatalogEntry,
	CatalogScanResponse,
} from "@/lib/agent";

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
	return {
		templateId: "opencode",
		name: "OpenCode",
		description: "",
		command: "opencode",
		args: ["acp"],
		installHint: "",
		binaryAvailable: true,
		acpCommandAvailable: true,
		acpBundled: false,
		acpStatus: "ready",
		registeredId: "catalog-opencode",
		isDefault: false,
		...overrides,
	};
}

function custom(overrides: Partial<AgentDescriptor>): AgentDescriptor {
	return {
		id: "custom-1",
		name: "Desktop",
		template: "custom",
		command: "desktop-acp",
		args: [],
		env: {},
		available: true,
		...overrides,
	};
}

function scan(overrides: Partial<CatalogScanResponse>): CatalogScanResponse {
	return {
		entries: [],
		customAgents: [],
		defaultId: null,
		enabled: true,
		proxyEnabled: false,
		proxyUrl: "",
		...overrides,
	};
}

describe("buildDefaultAgentChoices", () => {
	it("keeps the official Antigravity identity in the default selector", () => {
		const choices = buildDefaultAgentChoices(
			scan({
				entries: [
					entry({
						templateId: "antigravity-acp",
						name: "Antigravity",
						registeredId: "catalog-antigravity-acp",
					}),
				],
			}),
		);

		expect(choices).toMatchObject([
			{
				value: "catalog:antigravity-acp",
				template: "antigravity-acp",
			},
		]);
	});

	it("offers ready catalog agents and available custom agents", () => {
		const choices = buildDefaultAgentChoices(
			scan({
				defaultId: "custom-1",
				entries: [entry({ templateId: "hermes", name: "Hermes Agent" })],
				customAgents: [custom({})],
			}),
		);

		expect(choices.map((choice) => choice.value)).toEqual([
			"catalog:hermes",
			"custom:custom-1",
		]);
		expect(
			defaultAgentChoiceValue(scan({ defaultId: "custom-1" }), choices),
		).toBe("custom:custom-1");
	});

	it("filters install-only catalog rows out of the default selector", () => {
		const choices = buildDefaultAgentChoices(
			scan({
				entries: [
					entry({
						templateId: "pi",
						name: "Pi",
						binaryAvailable: false,
						acpCommandAvailable: false,
						canInstall: true,
						acpStatus: "missing",
					}),
				],
			}),
		);

		expect(choices).toEqual([]);
		expect(defaultAgentChoiceValue(scan({}), choices)).toBe(
			NO_DEFAULT_AGENT_CHOICE,
		);
	});

	it("uses the catalog value when a ready catalog entry is default", () => {
		const state = scan({
			defaultId: "catalog-codex-acp",
			entries: [
				entry({
					templateId: "codex-acp",
					name: "Codex",
					registeredId: "catalog-codex-acp",
					isDefault: true,
				}),
			],
		});
		const choices = buildDefaultAgentChoices(state);

		expect(defaultAgentChoiceValue(state, choices)).toBe("catalog:codex-acp");
	});

	it("offers a bundled-tier row as a usable default agent", () => {
		// No adapter on PATH; the bundled tier makes the ACP layer available
		// (host CLI still installed), so the row must be selectable.
		const choices = buildDefaultAgentChoices(
			scan({
				entries: [
					entry({
						templateId: "claude-acp",
						name: "Claude",
						acpBundled: true,
						acpBundledVersion: "0.79.0",
					}),
				],
			}),
		);

		expect(choices.map((choice) => choice.value)).toEqual([
			"catalog:claude-acp",
		]);
	});

	it.each([
		false,
		true,
	])("omits a bundled historical default without its host even if Ready (canInstall=%s)", (canInstall) => {
		const state = scan({
			defaultId: "catalog-claude-acp",
			entries: [
				entry({
					templateId: "claude-acp",
					registeredId: "catalog-claude-acp",
					isDefault: true,
					binaryAvailable: false,
					acpCommandAvailable: false,
					acpBundled: true,
					acpStatus: "ready",
					canInstall,
				}),
			],
		});
		const choices = buildDefaultAgentChoices(state);

		expect(choices).toEqual([]);
		expect(defaultAgentChoiceValue(state, choices)).toBe(
			NO_DEFAULT_AGENT_CHOICE,
		);
	});

	it("still excludes rows needing host installation with an available ACP command", () => {
		const choices = buildDefaultAgentChoices(
			scan({
				entries: [
					entry({
						binaryAvailable: false,
						acpCommandAvailable: true,
						canInstall: true,
					}),
				],
			}),
		);

		expect(choices).toEqual([]);
	});
});

describe("patchCatalogProbe", () => {
	it("ignores a late successful probe after a bundled agent loses its host", () => {
		const missing = entry({
			templateId: "claude-acp",
			registeredId: "catalog-claude-acp",
			isDefault: true,
			binaryAvailable: false,
			acpCommandAvailable: false,
			acpBundled: true,
			acpStatus: "missing",
			lastProbedAt: "2026-01-01T00:00:00.000Z",
		});
		const state = scan({
			entries: [missing, entry({})],
			defaultId: "catalog-claude-acp",
		});
		const next = patchCatalogProbe(state, "claude-acp", {
			agentId: "late-claude",
			available: true,
			agentName: "Claude",
		});

		expect(next).toEqual(state);
		expect(next.entries[0]).toBe(missing);
	});

	it.each([
		false,
		true,
	])("applies probe results while current dependencies are available (available=%s)", (available) => {
		const state = scan({
			entries: [entry({ acpStatus: "not-probed", registeredId: null })],
		});
		const next = patchCatalogProbe(state, "opencode", {
			agentId: "probed-opencode",
			available,
		});

		expect(next.entries[0]).toMatchObject({
			acpCommandAvailable: true,
			acpStatus: available ? "ready" : "failed",
			registeredId: "probed-opencode",
		});
	});
});

describe("showUpdateAgent", () => {
	it("shows Upgrade only when a newer silent-update target is known", () => {
		expect(
			showUpdateAgent(
				entry({
					canInstall: true,
					binaryAvailable: true,
					updateAvailable: true,
				}),
			),
		).toBe(true);
	});

	it("hides Upgrade when versions are equal or unknown", () => {
		expect(
			showUpdateAgent(
				entry({
					canInstall: true,
					binaryAvailable: true,
					updateAvailable: false,
				}),
			),
		).toBe(false);
		expect(
			showUpdateAgent(
				entry({
					canInstall: true,
					binaryAvailable: true,
					updateAvailable: undefined,
				}),
			),
		).toBe(false);
		expect(
			showUpdateAgent(
				entry({
					canInstall: true,
					binaryAvailable: false,
					updateAvailable: true,
				}),
			),
		).toBe(false);
		expect(
			showUpdateAgent(
				entry({
					canInstall: false,
					binaryAvailable: true,
					updateAvailable: true,
				}),
			),
		).toBe(false);
	});
});

describe("showUninstallAgent", () => {
	it("allows removal for a registry entry even without a binary", () => {
		expect(
			showUninstallAgent(
				entry({
					registeredId: "catalog-hermes",
					binaryAvailable: false,
					acpCommandAvailable: false,
					canInstall: false,
				}),
			),
		).toBe(true);
	});

	it("allows uninstall for an installed lifecycle template", () => {
		expect(
			showUninstallAgent(
				entry({
					registeredId: null,
					canInstall: true,
					binaryAvailable: true,
				}),
			),
		).toBe(true);
	});

	it("rejects an unregistered template with no binary", () => {
		expect(
			showUninstallAgent(
				entry({
					registeredId: null,
					canInstall: true,
					binaryAvailable: false,
				}),
			),
		).toBe(false);
	});

	it("rejects an installed binary whose template has no silent installer", () => {
		expect(
			showUninstallAgent(
				entry({
					templateId: "custom",
					registeredId: null,
					canInstall: false,
					binaryAvailable: true,
				}),
			),
		).toBe(false);
	});
});
