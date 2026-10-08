import { describe, expect, it } from "vitest";

import { canonicalPaperPdfPath } from "@/lib/paper/media";

describe("canonical paper PDF", () => {
	it("uses the paper folder name as {id}.pdf at the paper root", () => {
		expect(canonicalPaperPdfPath("/vault/papers/2401.12345")).toBe(
			"/vault/papers/2401.12345/2401.12345.pdf",
		);
		expect(canonicalPaperPdfPath("/vault/papers/2401.12345/")).toBe(
			"/vault/papers/2401.12345/2401.12345.pdf",
		);
		expect(canonicalPaperPdfPath("C:\\vault\\papers\\demo")).toBe(
			"C:\\vault\\papers\\demo\\demo.pdf",
		);
		expect(canonicalPaperPdfPath("remote:sess/papers/abc")).toBe(
			"remote:sess/papers/abc/abc.pdf",
		);
	});

	it("does not invent a path when the paper folder is missing", () => {
		expect(canonicalPaperPdfPath("")).toBeNull();
		expect(canonicalPaperPdfPath("   ")).toBeNull();
		expect(canonicalPaperPdfPath(".")).toBeNull();
		expect(canonicalPaperPdfPath("..")).toBeNull();
	});
});
