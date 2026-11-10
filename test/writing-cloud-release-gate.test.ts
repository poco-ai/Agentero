// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { openWritingCheckout } = vi.hoisted(() => ({
	openWritingCheckout: vi.fn(async () => null),
}));

vi.mock("@/hooks/use-writing-project", () => {
	const lookup = {
		status: "ready",
		project: {
			directory: "/vault/thesis/paper",
			manifest: { projectId: "paper" },
		},
	};
	return { useWritingProject: () => lookup };
});
vi.mock("@/lib/writing/cloud/checkout", () => ({
	onCheckoutChange: () => () => {},
}));
vi.mock("@/lib/writing/cloud/session", () => ({ openWritingCheckout }));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it.each([
	undefined,
	"0",
	"1",
])("uses the account build flag (%s) to control automatic cloud checkout", async (flag) => {
	vi.resetModules();
	vi.stubEnv("VITE_AGENTERO_ACCOUNT_SURFACE", flag);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	openWritingCheckout.mockClear();
	const { WritingCloudProvider } = await import(
		"@/components/writing/writing-cloud-context"
	);
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(
				createElement(WritingCloudProvider, {
					vault: "/vault",
					root: "/vault/thesis/paper/main.tex",
					// biome-ignore lint/correctness/noChildrenProp: required by the provider's props
					children: "Local editor",
				}),
			);
		});
		expect(container.textContent).toBe("Local editor");
		expect(openWritingCheckout).toHaveBeenCalledTimes(flag === "1" ? 1 : 0);
	} finally {
		await act(async () => root.unmount());
	}
});
