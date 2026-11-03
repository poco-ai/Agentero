// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PlainCodeBlock } from "@/components/agent/rendering/plain-code-block";
import { copyTextToClipboard } from "@/lib/core/clipboard";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/core/clipboard", () => ({
	copyTextToClipboard: vi.fn(async () => true),
}));
vi.mock("@/hooks/use-highlighted-code", () => ({
	useHighlightedCode: (code: string) => code.split("\n"),
}));

it("copies and downloads the original code through the application actions", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const blob = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:code");
	const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	let downloaded = "";
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		downloaded = this.download;
	});
	try {
		await act(() =>
			root.render(
				createElement(PlainCodeBlock, {
					className: "language-python",
					"data-block": true,
					children: "print('original')\n",
				} as never),
			),
		);
		await act(() =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="code.copy"]')
				?.click(),
		);
		expect(copyTextToClipboard).toHaveBeenCalledWith("print('original')", {
			successMessage: "code.copy",
		});
		await act(() =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="code.download"]')
				?.click(),
		);
		expect(downloaded).toBe("code.py");
		expect(blob).toHaveBeenCalledOnce();
		expect(await blob.mock.calls[0]?.[0].text()).toBe("print('original')");
		expect(revoke).toHaveBeenCalledWith("blob:code");
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
