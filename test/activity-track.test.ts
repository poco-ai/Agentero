import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => true,
}));

vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => "/Users/me/vault",
}));

const recordActivityEvents = vi.fn(async (events: unknown[]) => events.length);

vi.mock("@/lib/activity/api", () => ({
	recordActivityEvents: (events: unknown[]) => recordActivityEvents(events),
}));

import {
	flushActivity,
	pendingActivityCountForTests,
	resetActivityBufferForTests,
	track,
} from "@/lib/activity/track";

describe("activity track", () => {
	beforeEach(() => {
		resetActivityBufferForTests();
		recordActivityEvents.mockClear();
	});

	afterEach(() => {
		resetActivityBufferForTests();
	});

	it("buffers known kinds and stores vault-relative paths", async () => {
		track("paper.open", {
			path: "/Users/me/vault/papers/demo",
			mode: "pdf",
		});
		expect(pendingActivityCountForTests()).toBe(1);
		await flushActivity();
		expect(recordActivityEvents).toHaveBeenCalledTimes(1);
		const batch = recordActivityEvents.mock.calls[0]?.[0] as Array<{
			kind: string;
			path?: string;
			mode?: string;
			vault?: string;
		}>;
		expect(batch[0]?.kind).toBe("paper.open");
		expect(batch[0]?.path).toBe("papers/demo");
		expect(batch[0]?.mode).toBe("pdf");
		expect(batch[0]?.vault).toBe("/Users/me/vault");
	});

	it("dedupes the same kind+path within 1s", () => {
		track("paper.open", { path: "papers/demo", mode: "pdf" });
		track("paper.open", { path: "papers/demo", mode: "pdf" });
		expect(pendingActivityCountForTests()).toBe(1);
	});

	it("ignores unknown kinds", () => {
		track("not.a.kind");
		expect(pendingActivityCountForTests()).toBe(0);
	});
});
