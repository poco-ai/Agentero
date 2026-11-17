import { afterEach, beforeEach, vi } from "vitest";

export function useFakeTimers(): void {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});
}
