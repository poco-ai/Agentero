import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => false }));

import { requestPdfSelectionIntent } from "@/lib/navigator/decision-gateway";

describe("decision gateway fallback", () => {
	it("keeps the user-provided candidate set when Host is unavailable", async () => {
		await expect(
			requestPdfSelectionIntent({
				requestId: "r1",
				stateVersion: "1",
				state: { requestedAction: "translate" },
				targetIdentity: "selection:p:s",
				contextIdentity: "ctx",
				allowedActionIds: ["translate", "explain"],
			}),
		).resolves.toEqual({
			recommendation: null,
			allowedActionIds: ["translate", "explain"],
			traceId: "navigator:r1",
		});
	});
});
