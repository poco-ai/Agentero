import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
	attachComment,
	commentChatQuote,
	commentChatRecord,
	shiftComment,
	type TexComment,
} from "@/lib/tex/comments";

function thread(doc: string, from: number, to: number): TexComment {
	return {
		id: "c",
		file: "main.tex",
		quote: doc.slice(from, to),
		prefix: doc.slice(Math.max(0, from - 40), from),
		suffix: doc.slice(to, to + 40),
		from,
		to,
		detached: false,
		resolved: false,
		messages: [],
		createdAt: 0,
	};
}

describe("tex review comments", () => {
	it("shifts, grows, and detaches a range with the edit", () => {
		const before = "hello world";
		const moved = shiftComment(
			thread(before, 6, 11),
			ChangeSet.of([{ from: 0, to: 0, insert: "say " }], before.length),
			"say hello world",
		);
		expect(moved.quote).toBe("world");
		expect(moved.from).toBe(10);

		const grown = shiftComment(
			thread(before, 6, 11),
			ChangeSet.of([{ from: 7, to: 7, insert: "X" }], before.length),
			"hello wXorld",
		);
		expect(grown.quote).toBe("wXorld");
		expect(grown.detached).toBe(false);

		const gone = shiftComment(
			thread(before, 6, 11),
			ChangeSet.of([{ from: 6, to: 11, insert: "" }], before.length),
			"hello ",
		);
		expect(gone.detached).toBe(true);
	});

	it("reattaches a stale offset from the quote and its neighbors", () => {
		const doc = "one\\nhello world\\ntwo";
		const stale = thread("hello world", 0, 5);
		stale.prefix = "";
		stale.suffix = " world";
		stale.from = 0;
		const found = attachComment(`prefix ${doc}`, stale);
		expect(found.detached).toBe(false);
		expect(found.quote).toBe("hello");
		expect(found.from).toBe("prefix one\\n".length);
	});

	it("packs the thread and the live neighbors for chat", () => {
		const doc = "before the quote after";
		const item = thread(doc, 11, 16);
		item.messages = [
			{ id: "m1", body: "unclear", at: Date.UTC(2026, 10, 10, 3, 6) },
			{ id: "m2", body: "  ", at: 0 },
		];
		const quote = commentChatQuote(item, doc);
		expect(quote?.text).toBe("quote");
		expect(quote?.before).toBe("before the ");
		expect(quote?.after).toBe(" after");
		expect(quote?.lineFrom).toBe(1);
		expect(quote?.lineTo).toBe(1);
		const record = commentChatRecord(item);
		expect(record).toContain("status: open");
		expect(record).toContain("2026-11-10 03:06");
		expect(record).toContain("unclear");
		expect(record).not.toContain("2.");
	});
});
