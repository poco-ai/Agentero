// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCitationLink } from "@/components/agent/rendering/agent-citation-link";
import { type Mounted, mountRoot } from "./helpers/mount";

vi.mock("react-i18next", () => import("./helpers/i18n"));
vi.mock("@/lib/workspace/actions", () => ({ openCitation: vi.fn() }));

let mounted: Mounted;

beforeEach(() => {
	mounted = mountRoot();
});

afterEach(async () => {
	await mounted.unmount();
});

describe("AgentCitationLink streaming guard", () => {
	it("does not navigate an incomplete streaming citation", async () => {
		const onOpenSource = vi.fn();
		await mounted.render(
			createElement(
				AgentCitationLink,
				{ href: "streamdown:incomplete-link", onOpenSource },
				"Reference",
			),
		);
		const link = mounted.container.querySelector<HTMLAnchorElement>("a");
		expect(link?.hasAttribute("href")).toBe(false);
		await act(() => link?.click());
		expect(onOpenSource).not.toHaveBeenCalled();
	});
});
