// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	Reasoning,
	ReasoningTrigger,
} from "@/components/agent/elements/reasoning";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/agent/rendering/message-response", () => ({
	MessageResponse: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("reasoning disclosure", () => {
	it("opens for a new stream and closes after it completes", async () => {
		vi.useFakeTimers();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const render = (isStreaming: boolean) =>
			act(async () =>
				root.render(
					createElement(
						Reasoning,
						{ isStreaming },
						createElement(ReasoningTrigger),
					),
				),
			);
		await render(false);
		expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe(
			"false",
		);
		await render(true);
		expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe(
			"true",
		);
		await render(false);
		await act(async () => vi.advanceTimersByTime(1000));
		expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe(
			"false",
		);
		await act(async () => root.unmount());
	});

	it("keeps the user's collapsed state while reasoning continues", async () => {
		vi.useFakeTimers();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const render = (isStreaming: boolean) =>
			act(async () =>
				root.render(
					createElement(
						Reasoning,
						{ isStreaming },
						createElement(ReasoningTrigger),
					),
				),
			);
		await render(true);
		await act(async () => host.querySelector("button")?.click());
		await render(true);
		expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe(
			"false",
		);
		await render(false);
		await act(async () => vi.advanceTimersByTime(1000));
		expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe(
			"false",
		);
		await act(async () => root.unmount());
	});
});
