import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	consumeVivaOpenRequest,
	requestOpenViva,
} from "@/lib/voice-defense/open-request";
import { VIVA_WINDOW_LABEL } from "@/lib/voice-defense/viva-window";

describe("viva window routing", () => {
	it("uses a dedicated singleton window label", () => {
		expect(VIVA_WINDOW_LABEL).toBe("viva");
		const opener = readFileSync(
			new URL("../src/lib/voice-defense/viva-window.ts", import.meta.url),
			"utf8",
		);
		expect(opener).toContain("viva_window_open");
		expect(opener).toContain('get("window") === "viva"');
	});

	it("latches overlay open requests when not in the desktop app", () => {
		expect(consumeVivaOpenRequest()).toBe(false);
		requestOpenViva();
		expect(consumeVivaOpenRequest()).toBe(true);
		expect(consumeVivaOpenRequest()).toBe(false);
	});

	it("opens a native window from the desktop request path", () => {
		const request = readFileSync(
			new URL("../src/lib/voice-defense/open-request.ts", import.meta.url),
			"utf8",
		);
		expect(request).toContain("shouldOpenVivaAsWindow");
		expect(request).toContain("openVivaWindow");
	});
});
