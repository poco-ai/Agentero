/**
 * Shared Zustand store factory.
 *
 * Stores are created as *vanilla* stores (no React) wrapped with
 * `subscribeWithSelector`, then bound to React via `useStore`. Keeping the
 * vanilla store as the source of truth lets non-React callers read/update
 * state through `store.getState()` (replacing the ad-hoc `useRef` shadows the
 * old `App.tsx` used to escape stale closures) and lets unit tests drive a
 * store without rendering any component.
 */

import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useShallow as useShallowSelector } from "zustand/react/shallow";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";

/** Mutator tag added by the `subscribeWithSelector` middleware. */
type WithSelector = [["zustand/subscribeWithSelector", never]];

/** A vanilla store together with its React binding hooks. */
export interface AppStore<T> {
	/** Vanilla store: `getState`, `setState`, selector-aware `subscribe`. */
	readonly store: StoreApi<T>;
	/** Subscribe a component to a selected slice. */
	use<U>(selector: (state: T) => U): U;
	/** Like {@link AppStore.use} but compares the selected value shallowly. */
	useShallow<U>(selector: (state: T) => U): U;
}

/**
 * Create an application store from a state initializer.
 *
 * @example
 * const counter = createAppStore<{ n: number; inc(): void }>((set) => ({
 *   n: 0,
 *   inc: () => set((s) => ({ n: s.n + 1 })),
 * }));
 * counter.store.getState().inc();     // non-React / tests
 * const n = counter.use((s) => s.n);  // inside a component
 */
export function createAppStore<T>(
	initializer: StateCreator<T, WithSelector, []>,
): AppStore<T> {
	const store = createStore<T>()(subscribeWithSelector(initializer));

	return {
		store,
		use: (selector) => useStore(store, selector),
		useShallow: (selector) => useStore(store, useShallowSelector(selector)),
	};
}
