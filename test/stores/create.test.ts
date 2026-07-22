import { describe, expect, it, vi } from "vitest";

import { createAppStore } from "@/stores/create";

type CounterState = {
	n: number;
	label: string;
	inc: () => void;
	setLabel: (label: string) => void;
};

function makeCounter() {
	return createAppStore<CounterState>((set) => ({
		n: 0,
		label: "a",
		inc: () => set((s) => ({ n: s.n + 1 })),
		setLabel: (label) => set({ label }),
	}));
}

describe("createAppStore", () => {
	it("exposes vanilla getState/setState with working actions", () => {
		const counter = makeCounter();
		expect(counter.store.getState().n).toBe(0);

		counter.store.getState().inc();
		counter.store.getState().inc();
		expect(counter.store.getState().n).toBe(2);
	});

	it("subscribeWithSelector fires only when the selected slice changes", () => {
		const counter = makeCounter();
		const onN = vi.fn();

		const unsub = counter.store.subscribe((s) => s.n, onN);
		counter.store.getState().setLabel("b"); // unrelated slice
		expect(onN).not.toHaveBeenCalled();

		counter.store.getState().inc(); // selected slice changes
		expect(onN).toHaveBeenCalledTimes(1);
		expect(onN).toHaveBeenCalledWith(1, 0);

		unsub();
		counter.store.getState().inc();
		expect(onN).toHaveBeenCalledTimes(1);
	});
});
