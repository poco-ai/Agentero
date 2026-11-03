import { describe, expect, it, vi } from "vitest";
import { createWritingSelectionGroup } from "@/components/writing/writing-selection-group";

describe("writing selection group", () => {
	it("notifies every pane and stops after unsubscribe", () => {
		const group = createWritingSelectionGroup();
		const first = vi.fn();
		const second = vi.fn();
		const offFirst = group.subscribe(first);
		const offSecond = group.subscribe(second);

		group.announce("source");
		expect(first).toHaveBeenLastCalledWith("source");
		expect(second).toHaveBeenLastCalledWith("source");

		offFirst();
		group.announce("pdf");
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenLastCalledWith("pdf");

		offSecond();
		group.announce("source");
		expect(second).toHaveBeenCalledTimes(2);
	});
});
