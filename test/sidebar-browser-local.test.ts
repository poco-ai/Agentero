import { expect, it } from "vitest";
import { sidebarBrowserUrl } from "@/lib/web-view/sidebar-browser-url";

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
