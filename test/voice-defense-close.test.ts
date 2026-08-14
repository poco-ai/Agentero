import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldHandoffVoiceSession } from "@/lib/voice-defense/timing";

describe("voice defense close handoff", () => {
	const startedAt = new Date("2026-08-14T01:00:00.000Z");

	it("closes without a debrief until committee playback starts", () => {
		expect(shouldHandoffVoiceSession("live", null)).toBe(false);
		expect(shouldHandoffVoiceSession("error", null)).toBe(false);
	});

	it("keeps a started live or failed session for the debrief", () => {
		expect(shouldHandoffVoiceSession("live", startedAt)).toBe(true);
		expect(shouldHandoffVoiceSession("error", startedAt)).toBe(true);
	});

	it("never hands off setup or ended phases", () => {
		expect(shouldHandoffVoiceSession("prepare", startedAt)).toBe(false);
		expect(shouldHandoffVoiceSession("connecting", startedAt)).toBe(false);
		expect(shouldHandoffVoiceSession("ended", startedAt)).toBe(false);
	});

	it("wires both close paths to playback start rather than caption count", () => {
		const component = readFileSync(
			new URL("../src/components/agent/use-voice-defense.ts", import.meta.url),
			"utf8",
		);

		expect(component).toContain(
			"shouldHandoffVoiceSession(phase, startedAtRef.current)",
		);
		expect(component).toContain(
			"shouldHandoffVoiceSession(\n\t\t\t\t\t\tphaseRef.current,\n\t\t\t\t\t\tstartedAtRef.current,\n\t\t\t\t\t)",
		);
		expect(component).not.toContain(
			'(phase === "error" && captionsRef.current.length > 0)',
		);
	});

	it("allows the destroy command used by Tauri onCloseRequested", () => {
		const capability = JSON.parse(
			readFileSync(
				new URL("../src-tauri/capabilities/viva-window.json", import.meta.url),
				"utf8",
			),
		) as { windows: unknown[]; permissions: unknown[] };

		expect(capability.windows).toEqual(["viva"]);
		expect(capability.permissions).toContain("core:window:allow-destroy");

		const windowHelper = readFileSync(
			new URL("../src/lib/voice-defense/viva-window.ts", import.meta.url),
			"utf8",
		);
		expect(windowHelper).toContain("getCurrentWindow().destroy()");
	});
});
