import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CliInstallStatus,
	installCliCommand,
	syncCliWithApp,
} from "@/lib/cli/api";
import { commands } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";

vi.mock("@/lib/core/bindings", () => ({
	commands: {
		cliInstallStatus: vi.fn(),
		cliInstallCommand: vi.fn(),
	},
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: vi.fn() }));
vi.mock("@/lib/core/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}));

function status(patch: Partial<CliInstallStatus> = {}): CliInstallStatus {
	return {
		appVersion: "0.15.1",
		bundledVersion: null,
		bundledPath: null,
		source: null,
		cliVersion: null,
		downloadUrl: "https://example.com/cli.tar.gz",
		releasePageUrl: "https://example.com/release",
		canInstall: true,
		installed: false,
		autoInstallEnabled: true,
		installPath: null,
		shimCurrent: false,
		preferredBinDir: "/user/.local/bin",
		preferredBinOnPath: true,
		brewAvailable: false,
		commandName: "agentero",
		message: null,
		...patch,
	};
}

describe("startup CLI installation", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubEnv("DEV", false);
		vi.mocked(isTauri).mockReturnValue(true);
		vi.mocked(commands.cliInstallStatus).mockResolvedValue({
			ok: true,
			data: status(),
		});
		vi.mocked(commands.cliInstallCommand).mockResolvedValue({
			ok: true,
			data: {
				status: status({ installed: true, shimCurrent: true }),
				action: "download-install",
			},
		});
	});

	afterEach(() => vi.unstubAllEnvs());

	it("installs a missing CLI through the automatic Host path", async () => {
		expect(await syncCliWithApp()).toBe("synced");
		expect(commands.cliInstallCommand).toHaveBeenCalledExactlyOnceWith(true);
	});

	it("updates a stale installed CLI", async () => {
		vi.mocked(commands.cliInstallStatus).mockResolvedValue({
			ok: true,
			data: status({ installed: true, cliVersion: "0.15.0" }),
		});
		expect(await syncCliWithApp()).toBe("synced");
		expect(commands.cliInstallCommand).toHaveBeenCalledWith(true);
	});

	it.each([
		{ autoInstallEnabled: false },
		{ installed: true, shimCurrent: true },
		{ canInstall: false },
	])("skips installation for %j", async (patch) => {
		vi.mocked(commands.cliInstallStatus).mockResolvedValue({
			ok: true,
			data: status(patch),
		});
		expect(await syncCliWithApp()).toBe("skipped");
		expect(commands.cliInstallCommand).not.toHaveBeenCalled();
	});

	it("respects an uninstall that the Host observes during download", async () => {
		vi.mocked(commands.cliInstallCommand).mockResolvedValue({
			ok: true,
			data: {
				status: status({ autoInstallEnabled: false }),
				action: "skipped",
			},
		});
		expect(await syncCliWithApp()).toBe("skipped");
	});

	it("allows manual reinstall to override the opt-out", async () => {
		await installCliCommand();
		expect(commands.cliInstallCommand).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("reports a transient install failure so startup can retry", async () => {
		vi.mocked(commands.cliInstallCommand).mockRejectedValueOnce(
			new Error("release asset unavailable"),
		);
		expect(await syncCliWithApp()).toBe("failed");
		expect(await syncCliWithApp()).toBe("synced");
	});

	it("does not install when status cannot be read", async () => {
		vi.mocked(commands.cliInstallStatus).mockRejectedValue(new Error("IPC"));
		expect(await syncCliWithApp()).toBe("skipped");
		expect(commands.cliInstallCommand).not.toHaveBeenCalled();
	});

	it("does not install from a dev build or plain browser", async () => {
		vi.stubEnv("DEV", true);
		expect(await syncCliWithApp()).toBe("skipped");
		vi.stubEnv("DEV", false);
		vi.mocked(isTauri).mockReturnValue(false);
		expect(await syncCliWithApp()).toBe("skipped");
		expect(commands.cliInstallStatus).not.toHaveBeenCalled();
		expect(commands.cliInstallCommand).not.toHaveBeenCalled();
	});
});
