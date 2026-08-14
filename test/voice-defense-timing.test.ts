import { describe, expect, it } from "vitest";
import { nextVoiceSessionStartedAt } from "@/lib/voice-defense/timing";

describe("voice defense session timing", () => {
	it("starts when committee playback is actually enabled", () => {
		const connectingAt = new Date("2026-08-14T01:00:00.000Z");
		const playbackAt = new Date("2026-08-14T01:00:08.000Z");

		expect(
			nextVoiceSessionStartedAt(null, "connecting", connectingAt),
		).toBeNull();
		expect(nextVoiceSessionStartedAt(null, "playback", playbackAt)).toBe(
			playbackAt,
		);
	});

	it("never restarts the clock after playback begins", () => {
		const playbackAt = new Date("2026-08-14T01:00:09.000Z");
		const laterAt = new Date("2026-08-14T01:00:20.000Z");

		expect(nextVoiceSessionStartedAt(null, "playback", playbackAt)).toBe(
			playbackAt,
		);
		expect(nextVoiceSessionStartedAt(playbackAt, "playback", laterAt)).toBe(
			playbackAt,
		);
	});
});
