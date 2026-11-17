import { vi } from "vitest";

export class MockResizeObserver {
	static instances: MockResizeObserver[] = [];
	callback: ResizeObserverCallback;
	observed: Element[] = [];

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		MockResizeObserver.instances.push(this);
	}

	observe(target: Element): void {
		this.observed.push(target);
	}

	unobserve(target: Element): void {
		this.observed = this.observed.filter((el) => el !== target);
	}

	disconnect(): void {
		this.observed = [];
	}

	trigger(entries?: Partial<ResizeObserverEntry>[]): void {
		this.callback(
			(entries ??
				this.observed.map((target) => ({ target }))) as ResizeObserverEntry[],
			this as unknown as ResizeObserver,
		);
	}
}

export function installResizeObserver(): typeof MockResizeObserver {
	MockResizeObserver.instances = [];
	vi.stubGlobal("ResizeObserver", MockResizeObserver);
	return MockResizeObserver;
}

export function installMatchMedia(matches = false): void {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches,
		media: query,
		onchange: null,
		addListener: () => undefined,
		removeListener: () => undefined,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		dispatchEvent: () => false,
	}));
}
