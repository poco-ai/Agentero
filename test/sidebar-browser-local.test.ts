import { afterEach, expect, it, vi } from "vitest";
import {
	sidebarBrowserUrl,
	supportsSidebarBrowser,
} from "@/lib/web-view/sidebar-browser-url";

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubPlatform(options: {
	tauri?: boolean;
	platform?: string;
	userAgent?: string;
	maxTouchPoints?: number;
	search?: string;
}) {
	vi.stubGlobal(
		"window",
		options.tauri
			? {
					__TAURI_INTERNALS__: {},
					location: { search: options.search ?? "" },
				}
			: {
					location: { search: options.search ?? "" },
				},
	);
	vi.stubGlobal("navigator", {
		platform: options.platform ?? "",
		userAgent: options.userAgent ?? "",
		maxTouchPoints: options.maxTouchPoints ?? 0,
	});
}

it("enables embedded sidebar browsing on desktop Tauri targets and disables mobile or web", () => {
	stubPlatform({
		tauri: true,
		platform: "MacIntel",
		userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
	});
	expect(supportsSidebarBrowser()).toBe(true);

	stubPlatform({
		tauri: true,
		platform: "Win32",
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/131.0.0.0",
	});
	expect(supportsSidebarBrowser()).toBe(true);

	stubPlatform({
		tauri: true,
		platform: "Linux x86_64",
		userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
	});
	expect(supportsSidebarBrowser()).toBe(true);

	// Plain web browser (non-Tauri)
	stubPlatform({
		tauri: false,
		platform: "Win32",
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
	});
	expect(supportsSidebarBrowser()).toBe(false);

	// Mobile targets: iPhone, iPadOS (MacIntel + touch), Android, mobilePreview
	stubPlatform({
		tauri: true,
		platform: "iPhone",
		userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
	});
	expect(supportsSidebarBrowser()).toBe(false);

	stubPlatform({
		tauri: true,
		platform: "MacIntel",
		userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
		maxTouchPoints: 5,
	});
	expect(supportsSidebarBrowser()).toBe(false);

	stubPlatform({
		tauri: true,
		platform: "Linux aarch64",
		userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
	});
	expect(supportsSidebarBrowser()).toBe(false);

	stubPlatform({
		tauri: true,
		platform: "Win32",
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
		search: "?mobilePreview=1",
	});
	expect(supportsSidebarBrowser()).toBe(false);

	// Unknown / unrecognized desktop OS
	stubPlatform({
		tauri: true,
		platform: "FreeBSD",
		userAgent: "Mozilla/5.0 (FreeBSD)",
	});
	expect(supportsSidebarBrowser()).toBe(false);
});

it("opens HTTP(S) addresses, including domains and explicit file URLs on public servers", () => {
	expect(sidebarBrowserUrl(" https://example.org/papers/1.pdf ")).toBe(
		"https://example.org/papers/1.pdf",
	);
	expect(sidebarBrowserUrl("example.org/read")).toBe(
		"https://example.org/read",
	);
	expect(sidebarBrowserUrl("http://localhost:9000/?page=2")).toBe(
		"http://localhost:9000/?page=2",
	);
});

it("leaves paper identifiers, vault files, and ordinary queries in file search", () => {
	for (const input of [
		"2410.00001",
		"2410.00001v2",
		"notes.md",
		"report.html",
		"paper.pdf",
		"papers/notes.md",
		"Research Title",
	]) {
		expect(sidebarBrowserUrl(input), input).toBeNull();
	}
});

it("does not navigate to privileged schemes or send embedded credentials", () => {
	for (const input of [
		"file:///tmp/report.html",
		"javascript:alert(1)",
		"agentero://localhost/paper",
		"https://user:secret@example.org",
		"https://",
		"https://example.org\\notes",
	]) {
		expect(sidebarBrowserUrl(input, true), input).toBeNull();
	}
});
