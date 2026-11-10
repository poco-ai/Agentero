import { describe, expect, it } from "vitest";
import { isDesktopBundledCliPath } from "@/lib/system/desktop-apps";

describe("isDesktopBundledCliPath", () => {
	it("detects macOS app bundle CLIs", () => {
		expect(
			isDesktopBundledCliPath(
				"/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
			),
		).toBe(true);
		expect(
			isDesktopBundledCliPath(
				"/Applications/QwenWorkCN.app/Contents/Resources/bin/qoderclicn",
			),
		).toBe(true);
		expect(
			isDesktopBundledCliPath(
				"/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
			),
		).toBe(true);
	});

	it("detects Windows desktop installs", () => {
		expect(
			isDesktopBundledCliPath(
				"C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
			),
		).toBe(true);
		expect(
			isDesktopBundledCliPath(
				"C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd",
			),
		).toBe(true);
	});

	it("ignores PATH installs and empty values", () => {
		expect(isDesktopBundledCliPath("/Users/me/.local/bin/qoderclicn")).toBe(
			false,
		);
		expect(
			isDesktopBundledCliPath(
				"/opt/homebrew/lib/node_modules/x/resources/bin/y",
			),
		).toBe(false);
		expect(isDesktopBundledCliPath(null)).toBe(false);
		expect(isDesktopBundledCliPath(undefined)).toBe(false);
	});
});
