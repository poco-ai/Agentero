import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitScoped } from "@/lib/lifecycle/bus";
import { registerLifecycleHandlers } from "@/lib/lifecycle/register";

const mocks = vi.hoisted(() => {
	type CommandSpy = ReturnType<typeof vi.fn>;
	const commandSpies = new Map<string, CommandSpy>();
	return {
		/** Plain `ApiResult<T>` envelope, as returned by non-typedError commands. */
		commandSpy: (name: string): CommandSpy => {
			let spy = commandSpies.get(name);
			if (!spy) {
				spy = vi.fn(async () => ({ ok: true, data: null }));
				commandSpies.set(name, spy);
			}
			return spy;
		},
		// Faithful to the real helper: invoke the bound command and unwrap.
		callApi: vi.fn(
			async (fn: () => Promise<{ ok: boolean; data?: unknown }>) => {
				const res = await fn();
				if (!res.ok) throw new Error("host error");
				return res.data;
			},
		),
		callApiResult: vi.fn(async () => undefined),
		callResult: vi.fn(async () => undefined),
		clearLibraryVaultState: vi.fn(),
		clearWikiVaultState: vi.fn(),
		clearAgentVaultState: vi.fn(),
		clearAnnotationsVaultState: vi.fn(),
		clearLayoutVaultState: vi.fn(),
		clearUiVaultState: vi.fn(),
		refreshTree: vi.fn(async () => undefined),
		refreshLibrary: vi.fn(async () => undefined),
		seedVaultSkills: vi.fn(),
		scheduleTreeRefresh: vi.fn(),
		getVaultPath: vi.fn(() => "/vault-a"),
	};
});

vi.mock("@/lib/core/ipc", () => ({
	callApi: mocks.callApi,
	callApiResult: mocks.callApiResult,
	callResult: mocks.callResult,
}));
vi.mock("@/lib/core/bindings", () => ({
	commands: new Proxy({} as Record<string, unknown>, {
		get: (_target, prop) =>
			typeof prop === "string" ? mocks.commandSpy(prop) : undefined,
	}),
	events: new Proxy({} as Record<string, unknown>, {
		get: () => ({ listen: vi.fn(async () => vi.fn()) }),
	}),
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/logger", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/agent/agent-session-store", () => ({
	clearAgentVaultState: mocks.clearAgentVaultState,
}));
vi.mock("@/lib/lifecycle/refresh-wave", () => ({
	noteCommittedLibraryList: vi.fn(),
	noteCommittedPaths: vi.fn(),
	noteCommittedRename: vi.fn(),
	registerExternalLibraryReconciler: vi.fn(),
}));
vi.mock("@/lib/paper/library-store", () => ({
	clearLibraryVaultState: mocks.clearLibraryVaultState,
	refreshLibrary: mocks.refreshLibrary,
	scheduleLibraryRefresh: vi.fn(),
}));
vi.mock("@/lib/pdf/annotations-store", () => ({
	clearAnnotationsVaultState: mocks.clearAnnotationsVaultState,
}));
vi.mock("@/lib/pdf/layout/store", () => ({
	clearLayoutVaultState: mocks.clearLayoutVaultState,
}));
vi.mock("@/lib/shell/feature-window", () => ({
	isFeatureViewType: (v: unknown) => v === "agent",
}));
vi.mock("@/lib/shell/ui-store", () => ({
	clearUiVaultState: mocks.clearUiVaultState,
	setFeaturePoppedOut: vi.fn(),
	setSettingsOpenState: vi.fn(),
}));
vi.mock("@/lib/vault/actions", () => ({
	seedVaultSkills: mocks.seedVaultSkills,
}));
vi.mock("@/lib/vault/path", () => ({
	joinVaultPath: (a: string, b: string) => `${a}/${b}`,
}));
vi.mock("@/lib/vault/remote/remote-vault", () => ({
	isRemoteVaultHandle: (p: string) => p.startsWith("remote:"),
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: mocks.getVaultPath,
	refreshTree: mocks.refreshTree,
	scheduleTreeRefresh: mocks.scheduleTreeRefresh,
}));
vi.mock("@/lib/wiki/store", () => ({
	clearWikiVaultState: mocks.clearWikiVaultState,
	rebuildWikiAndNotify: vi.fn(async () => undefined),
}));

async function drain(): Promise<void> {
	for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const clears = [
	mocks.clearLibraryVaultState,
	mocks.clearWikiVaultState,
	mocks.clearAgentVaultState,
	mocks.clearAnnotationsVaultState,
	mocks.clearLayoutVaultState,
	mocks.clearUiVaultState,
];

describe("vault:opened scope", () => {
	let unregister: () => void;

	beforeEach(async () => {
		unregister?.();
		await drain();
		vi.clearAllMocks();
		unregister = registerLifecycleHandlers();
	});

	it("sets up the vault without clearing anything yet", async () => {
		const release = emitScoped("vault:opened", {
			vaultId: "/vault-a",
			timestamp: 1,
		});
		await drain();

		expect(mocks.refreshTree).toHaveBeenCalledWith("/vault-a");
		expect(mocks.seedVaultSkills).toHaveBeenCalledWith("/vault-a");
		// The window registers its hold in setup; the Host only releases when
		// the last holder lets go (see `vault_session::VaultHolders`).
		expect(mocks.commandSpy("vaultHold")).toHaveBeenCalledWith("/vault-a");
		for (const clear of clears) expect(clear).not.toHaveBeenCalled();
		expect(mocks.commandSpy("vaultRelease")).not.toHaveBeenCalled();

		release();
		await drain();
	});

	it("clears every vault-scoped store and releases the Host catalog", async () => {
		const release = emitScoped("vault:opened", {
			vaultId: "/vault-a",
			timestamp: 1,
		});
		await drain();
		release();
		await drain();

		for (const clear of clears) expect(clear).toHaveBeenCalledTimes(1);
		expect(mocks.commandSpy("vaultRelease")).toHaveBeenCalledWith("/vault-a");
		expect(mocks.callApi).toHaveBeenCalledWith(expect.any(Function), {
			fallback: "vault release failed",
		});
	});

	it("skips the Host hold and release for remote vaults, which have no local catalog", async () => {
		const release = emitScoped("vault:opened", {
			vaultId: "remote:abc",
			timestamp: 1,
		});
		await drain();
		release();
		await drain();

		for (const clear of clears) expect(clear).toHaveBeenCalledTimes(1);
		expect(mocks.commandSpy("vaultHold")).not.toHaveBeenCalled();
		expect(mocks.commandSpy("vaultRelease")).not.toHaveBeenCalled();
	});

	it("releases the previous vault before setting up the next one", async () => {
		const order: string[] = [];
		mocks.clearLibraryVaultState.mockImplementation(() => {
			order.push("release");
		});
		mocks.refreshTree.mockImplementation(async (vault: string) => {
			order.push(`setup:${vault}`);
		});

		const release = emitScoped("vault:opened", {
			vaultId: "/vault-a",
			timestamp: 1,
		});
		await drain();
		// A vault switch releases the old scope and opens the new one in one tick.
		release();
		const release2 = emitScoped("vault:opened", {
			vaultId: "/vault-b",
			timestamp: 2,
		});
		await drain();

		expect(order).toEqual(["setup:/vault-a", "release", "setup:/vault-b"]);
		release2();
		await drain();
	});
});
