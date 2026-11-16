// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTypewriter } from "@/hooks/use-typewriter";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.useRealTimers();
});

/** Render the hook's output as `<text>|<typing>`. */
function Probe({
	target,
	enabled = true,
}: {
	target: string;
	enabled?: boolean;
}): ReactNode {
	const { text, typing } = useTypewriter(target, enabled);
	return `${text}|${typing}`;
}

function render(node: ReactNode) {
	act(() => root.render(node));
	return host.textContent ?? "";
}

/** Let the reveal run for `ms` of frame time. */
function advance(ms: number) {
	act(() => vi.advanceTimersByTime(ms));
}

describe("useTypewriter", () => {
	it("reveals progressively and settles on the full target", () => {
		expect(render(createElement(Probe, { target: "hello world" }))).toBe(
			"|true",
		);
		advance(40);
		const midway = render(createElement(Probe, { target: "hello world" }));
		expect(midway).not.toBe("hello world|false");
		expect(midway.endsWith("|true")).toBe(true);
		advance(1_000);
		expect(render(createElement(Probe, { target: "hello world" }))).toBe(
			"hello world|false",
		);
	});

	it("shows disabled targets at once and does not replay when re-enabled", () => {
		expect(
			render(createElement(Probe, { target: "你好", enabled: false })),
		).toBe("你好|false");
		expect(
			render(createElement(Probe, { target: "你好", enabled: true })),
		).toBe("你好|false");
	});

	it("never cuts a surrogate pair in half", () => {
		render(createElement(Probe, { target: "😀😀" }));
		advance(30);
		const shown = render(createElement(Probe, { target: "😀😀" })).split(
			"|",
		)[0];
		expect(["", "😀", "😀😀"]).toContain(shown);
	});
});
