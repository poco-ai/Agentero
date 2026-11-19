import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueTaskSettledMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/core/bindings", () => ({
	commands: {
		detectLatexEngines: vi.fn(async () => ({
			ok: true,
			data: [{ id: "xelatex", label: "XeLaTeX", path: "/usr/bin/xelatex" }],
		})),
	},
}));

vi.mock("@/lib/tex/auto-build", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/tex/auto-build")>()),
	startTexAutoBuild: vi.fn(),
}));

vi.mock("@/lib/core/tasks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/core/tasks")>()),
	enqueueTaskSettled: enqueueTaskSettledMock,
}));

vi.mock("@/lib/vault/fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vault/fs")>()),
	readVaultFile: vi.fn(async () => "documentclass{article}"),
}));

vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
	notifySuccess: vi.fn(),
	notifyUndo: vi.fn(),
	notifyWarning: vi.fn(),
}));

import { notifyError } from "@/lib/core/notify";
import { texBuildStore } from "@/lib/tex/build-state";
// Import after the mocks: compileTexFile runs through mocked barrels.
import { compileTexFile, texCompileStore } from "@/lib/workspace/tex-compile";

const ROOT = "/Users/philfan/l/paper/thesis/main.tex";

beforeEach(() => {
	vi.mocked(notifyError).mockClear();
	enqueueTaskSettledMock
		.mockReset()
		.mockRejectedValue(new Error("Undefined control sequence"));
	texCompileStore.setState({ compilingPath: null });
	texBuildStore.setState({ byRoot: {}, dependencies: {} });
});

describe("compileTexFile failure reporting", () => {
	it("leaves the failure to the problems card without a toast", async () => {
		expect(await compileTexFile(ROOT)).toBeNull();

		expect(notifyError).not.toHaveBeenCalled();
		const snapshot = texBuildStore.getState().byRoot[ROOT];
		expect(snapshot?.status).toBe("failed");
		expect(snapshot?.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "error",
				message: "Undefined control sequence",
			}),
		);
	});
});
