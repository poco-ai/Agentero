import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { ByteIndex } from "@/lib/tex-live/byte-index";
import { useTexLiveStatusStore } from "@/lib/tex-live/status";

describe("tex-live ByteIndex", () => {
	it("maps UTF-16 positions to UTF-8 bytes on mixed text", () => {
		const doc = Text.of(["你好 world", "abc"]);
		const index = new ByteIndex(doc);
		expect(index.byteAt(doc, 0)).toBe(0);
		expect(index.byteAt(doc, 1)).toBe(3); // after 你
		expect(index.byteAt(doc, 2)).toBe(6); // after 你好
		expect(index.byteAt(doc, doc.line(2).from)).toBe(13); // 6 + space + "world" + \n
	});

	it("rebuilds line starts after an edit", () => {
		const before = Text.of(["abc", "def"]);
		const index = new ByteIndex(before);
		const after = Text.of(["abc你", "def"]);
		index.update(after, 1);
		expect(index.byteAt(after, after.line(2).from)).toBe(7);
	});

	it("rebuilds when a different document is passed", () => {
		const first = Text.of(["aa"]);
		const index = new ByteIndex(first);
		const second = Text.of(["aa", "bb"]);
		expect(index.byteAt(second, second.line(2).from)).toBe(3);
	});
});

describe("live preview status ownership", () => {
	it("keeps the surviving pane ready when its sibling closes", () => {
		const { setStatus, clearStatus } = useTexLiveStatusStore.getState();
		const first = Symbol();
		const second = Symbol();
		const root = "/vault/main.tex";
		const ready = { status: "live" as const, error: null };
		setStatus(root, ready, first);
		setStatus(root, ready, second);
		clearStatus(root, first);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toEqual(ready);
		clearStatus(root, second);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toBeUndefined();
	});

	it("restores the remaining pane's last status when the latest publisher closes", () => {
		const { setStatus, clearStatus } = useTexLiveStatusStore.getState();
		const first = Symbol();
		const second = Symbol();
		const root = "/vault/other.tex";
		const failed = { status: "failed" as const, error: "engine failed" };
		setStatus(root, failed, first);
		setStatus(root, { status: "live", error: null }, second);
		clearStatus(root, second);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toEqual(failed);
		clearStatus(root, first);
	});

	it("ignores repeated or unrelated pane cleanup without clearing a surviving publisher", () => {
		const { setStatus, clearStatus } = useTexLiveStatusStore.getState();
		const owner = Symbol();
		const unknown = Symbol();
		const root = "/vault/final.tex";
		const waiting = { status: "waiting" as const, error: null };
		setStatus(root, waiting, owner);
		clearStatus(root, unknown);
		clearStatus(root, unknown);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toEqual(waiting);
		clearStatus(root, owner);
		clearStatus(root, owner);
		expect(useTexLiveStatusStore.getState().byRoot[root]).toBeUndefined();
	});
});
