import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeApi } = vi.hoisted(() => ({ invokeApi: vi.fn() }));

vi.mock("@/lib/core/ipc", () => ({ invokeApi }));

import { fingerprintVaultFile, writeVaultFileAtomic } from "@/lib/vault/fs";

describe("Host-owned Vault file APIs", () => {
	beforeEach(() => {
		invokeApi.mockReset();
	});

	it("fingerprints through the Host without reading bytes in the WebView", async () => {
		const fingerprint = {
			path: "papers/demo/paper.pdf",
			size: 42,
			mtime: 123,
			hash: "abc",
		};
		invokeApi.mockResolvedValue(fingerprint);

		await expect(
			fingerprintVaultFile("/vault", "papers/demo/paper.pdf"),
		).resolves.toEqual(fingerprint);
		expect(invokeApi).toHaveBeenCalledWith("vault_file_fingerprint", {
			vaultRoot: "/vault",
			vaultRelativePath: "papers/demo/paper.pdf",
		});
	});

	it("writes atomic text through the same local/remote command", async () => {
		invokeApi.mockResolvedValue(null);

		await writeVaultFileAtomic(
			"remote:session-1",
			".agentero/defense/manifest.json",
			'{"version":1}',
		);
		expect(invokeApi).toHaveBeenCalledWith("vault_write_text_atomic", {
			vaultRoot: "remote:session-1",
			vaultRelativePath: ".agentero/defense/manifest.json",
			content: '{"version":1}',
		});
	});
});
