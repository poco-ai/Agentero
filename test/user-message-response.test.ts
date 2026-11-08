// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UserMessageResponse } from "@/components/agent/rendering/user-message-response";

vi.mock("@/components/agent/rendering/message-response", () => ({
	MessageResponse: ({ children }: { children: ReactNode }) =>
		createElement("div", { "data-markdown": true }, children),
}));

it("collapses the path and lets the user reveal and select it without opening a file", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const path = String.raw`C:\Users\Louis\.pi-desktop\scratch\session\pasted\pasted-context.txt`;
	try {
		await act(() =>
			root.render(
				createElement(UserMessageResponse, null, `Read this\n\n@${path}`),
			),
		);
		expect(host.textContent).toContain("Read this");
		expect(host.textContent).toContain("pasted-context.txt");
		expect(host.textContent).not.toContain(path);
		const button = host.querySelector("button");
		if (!button) throw new Error("Missing attachment toggle");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.title).toBe(path);
		await act(() => button.click());
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(host.textContent).toContain(path);
		expect(host.querySelector("a")).toBeNull();
		await act(() => button.click());
		expect(host.textContent).not.toContain(path);
	} finally {
		await act(() => root.unmount());
		host.remove();
	}
});
