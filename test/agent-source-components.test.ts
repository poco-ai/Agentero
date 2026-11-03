// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextSourceLinks } from "@/components/agent/context-source-links";
import { AgentCitationLink } from "@/components/agent/rendering/agent-citation-link";

const openCitation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace/actions", () => ({ openCitation }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, args?: { count: number }) =>
			args ? `${args.count} sources` : key,
	}),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	openCitation.mockClear();
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
});

describe("source components", () => {
	it("deduplicates source paths and keeps vault navigation after expanding", async () => {
		await act(() =>
			root.render(
				createElement(ContextSourceLinks, {
					sources: [
						" papers/a.pdf#page=2 ",
						"papers/a.pdf#page=2",
						"",
						"notes/a.md",
					],
				}),
			),
		);
		const toggle = container.querySelector<HTMLButtonElement>("button");
		expect(toggle?.textContent).toContain("2 sources");
		await act(() => toggle?.click());
		const link = container.querySelector<HTMLButtonElement>(
			'[aria-label="papers/a.pdf#page=2"]',
		);
		expect(link).not.toBeNull();
		await act(() => link?.click());
		expect(openCitation).toHaveBeenCalledWith("papers/a.pdf#page=2");
	});

	it("keeps citation rewrite and click routing when composed with HoverCard", async () => {
		const onOpenSource = vi.fn();
		await act(() =>
			root.render(
				createElement(
					AgentCitationLink,
					{ href: "papers/a/source/main.tex#page=2", onOpenSource },
					"Reference",
				),
			),
		);
		const link = container.querySelector<HTMLAnchorElement>("a");
		expect(link?.getAttribute("href")).toBe("papers/a/a.pdf#page=2");
		await act(() => link?.click());
		expect(onOpenSource).toHaveBeenCalledWith("papers/a/a.pdf#page=2");
	});

	it("does not navigate an incomplete streaming citation", async () => {
		const onOpenSource = vi.fn();
		await act(() =>
			root.render(
				createElement(
					AgentCitationLink,
					{ href: "streamdown:incomplete-link", onOpenSource },
					"Reference",
				),
			),
		);
		const link = container.querySelector<HTMLAnchorElement>("a");
		expect(link?.hasAttribute("href")).toBe(false);
		await act(() => link?.click());
		expect(onOpenSource).not.toHaveBeenCalled();
	});
});
