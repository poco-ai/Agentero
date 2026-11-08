// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
	createMarkdownSourceView,
	loadMarkdownSourceView,
} from "@/components/editor/markdown-source-view";

const hosts: HTMLElement[] = [];

function mount(source: string) {
	const host = document.createElement("div");
	document.body.append(host);
	hosts.push(host);
	const view = createMarkdownSourceView(host);
	loadMarkdownSourceView(view, source, {
		save: () => {},
		update: () => {},
		prefs: {
			dark: false,
			zwspLabel: "零宽空格占位",
			phrases: { "Markdown source": "Markdown source" },
		},
	});
	return { host, view };
}

afterEach(() => {
	for (const host of hosts.splice(0)) host.remove();
});

describe("Markdown source zero-width space marker", () => {
	it("draws U+200B as a muted labeled dot instead of CodeMirror's red glyph", () => {
		// U+200E keeps the upstream marker, U+200B gets ours.
		const { host, view } = mount("A\u200e\n\n\u200b\n\nB\n");

		const marker = host.querySelector(".cm-zwsp-marker");
		expect(marker?.textContent).toBe("·");
		expect(marker?.getAttribute("title")).toBe("零宽空格占位");
		expect(marker?.getAttribute("aria-label")).toBe("零宽空格占位");
		expect(host.querySelectorAll(".cm-specialChar")).toHaveLength(1);

		view.destroy();
	});
});
