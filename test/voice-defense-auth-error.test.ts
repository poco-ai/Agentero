import { describe, expect, it } from "vitest";
import { describeVoiceAuthError } from "@/lib/voice-defense/api";

describe("describeVoiceAuthError", () => {
	it("keeps ordinary Host messages", () => {
		expect(describeVoiceAuthError("ChatGPT is not connected", "owner")).toBe(
			"ChatGPT is not connected",
		);
	});

	it("rewrites Keychain owner-edit failures", () => {
		expect(
			describeVoiceAuthError(
				"could not remove the ChatGPT credential: Invalid attempt to change the owner of this item.",
				"owner",
			),
		).toBe("owner");
		expect(
			describeVoiceAuthError(
				"could not remove the ChatGPT credential: keychain owner conflict",
				"owner",
			),
		).toBe("owner");
	});
});
