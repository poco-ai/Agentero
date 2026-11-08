import { describe, expect, it } from "vitest";
import { splitPiAttachmentReferences } from "@/lib/agent/pi-attachment-display";

const path = String.raw`C:\Users\Louis\.pi-desktop\scratch\session-1\pasted\pasted-uuid-pasted-text-hash.txt`;

describe("Pi attachment display", () => {
	it("preserves the exact prompt while separating generated references", () => {
		const text = `Explain this\r\n\r\n@${path}\r\n\r\n**Keep the question.**`;
		const parts = splitPiAttachmentReferences(text);
		expect(parts.map((p) => p.text).join("")).toBe(text);
		expect(parts.filter((p) => p.path).map((p) => p.path)).toEqual([path]);
	});

	it("supports quoted Windows paths with spaces and POSIX paths", () => {
		const spaced = path.replace("Louis", "Louis Wu");
		const unix =
			"/Users/louis/.pi-desktop/scratch/session/pasted/pasted-context.txt";
		expect(
			splitPiAttachmentReferences(`@"${spaced}"\n@${unix}`).map((p) => p.path),
		).toEqual([spaced, unix]);
	});

	it.each([
		`Here is @${path}`,
		`\`@${path}\``,
		`    @${path}`,
		`> @${path}`,
		"@C:\\Users\\Louis\\paper.txt",
		"@papers/paper.pdf",
		"@https://example.com/.pi-desktop/scratch/s/pasted/pasted-file.txt",
		"@/tmp/scratch/s/pasted/pasted-file.txt",
	])("does not reinterpret ordinary prose, code or unrelated paths: %s", (text) => {
		expect(splitPiAttachmentReferences(text)).toEqual([{ text, start: 0 }]);
	});

	it.each([
		"```",
		"~~~~",
	])("leaves references inside %s fences unchanged", (fence) => {
		const code = `${fence}text\n@${path}\n${fence}\n`;
		const text = `${code}\n@${path}`;
		const parts = splitPiAttachmentReferences(text);
		expect(parts[0].text).toContain(code);
		expect(parts.filter((p) => p.path)).toHaveLength(1);
		expect(parts.map((p) => p.text).join("")).toBe(text);
	});
});
