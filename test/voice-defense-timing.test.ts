import { describe, expect, it } from "vitest";
import { nextVoiceSessionStartedAt } from "@/lib/voice-defense/timing";

describe("voice defense session timing", () => {
	it("starts on the first spoken activity instead of connection setup", () => {
		const connectingAt = new Date("2026-08-14T01:00:00.000Z");
		const speakingAt = new Date("2026-08-14T01:00:08.000Z");

		expect(
			nextVoiceSessionStartedAt(null, "connecting", connectingAt),
		).toBeNull();
		expect(nextVoiceSessionStartedAt(null, "speaking", speakingAt)).toBe(
			speakingAt,
		);
	});

	it("uses a visible caption as a fallback and never restarts the clock", () => {
		const captionAt = new Date("2026-08-14T01:00:09.000Z");
		const laterAt = new Date("2026-08-14T01:00:20.000Z");

		expect(nextVoiceSessionStartedAt(null, "caption", captionAt)).toBe(
			captionAt,
		);
		expect(nextVoiceSessionStartedAt(captionAt, "speaking", laterAt)).toBe(
			captionAt,
		);
	});
});
