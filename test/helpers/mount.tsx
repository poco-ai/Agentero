import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

export interface Mounted {
	container: HTMLDivElement;
	render: (element: ReactElement) => Promise<void>;
	unmount: () => Promise<void>;
}

// Test files using this helper need a `// @vitest-environment happy-dom` (or jsdom) pragma.
export function mountRoot(): Mounted {
	(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	document.body.append(container);
	let root: Root | null = createRoot(container);
	return {
		container,
		async render(element) {
			await act(async () => {
				root?.render(element);
			});
		},
		async unmount() {
			await act(async () => {
				root?.unmount();
			});
			root = null;
			container.remove();
		},
	};
}

export interface MountedHook<P, H> {
	result: { current: H };
	container: HTMLDivElement;
	render: (props?: P) => Promise<void>;
	unmount: () => Promise<void>;
}

export function mountHook<P, H>(
	useHook: (props: P) => H,
	initialProps: P,
): MountedHook<P, H> {
	const mounted = mountRoot();
	const result = { current: undefined as unknown as H };
	function Probe(props: P) {
		result.current = useHook(props);
		return null;
	}
	return {
		result,
		container: mounted.container,
		async render(props: P = initialProps) {
			await mounted.render(createElement(Probe, props));
		},
		unmount: mounted.unmount,
	};
}
