// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaperTitle } from "@/components/paper/paper-title";

function renderTitle(text: string) {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(
		createElement(PaperTitle, { text }),
	);
	return container;
}

describe("paper title formatting (#935)", () => {
	it("renders publisher italics and exposes a readable tooltip", () => {
		const title = renderTitle(
			"<i>Phaser.MRage</i>: automated molecular replacement",
		);
		expect(title.querySelector("i")?.textContent).toBe("Phaser.MRage");
		expect(title.textContent).toBe(
			"Phaser.MRage: automated molecular replacement",
		);
		expect(title.firstElementChild?.getAttribute("title")).toBe(
			title.textContent,
		);
	});

	it("preserves nested emphasis, chemical subscripts, superscripts and entities", () => {
		const title = renderTitle(
			"<strong><em>H<sub>2</sub>O</em></strong> &amp; Mn<sup>2+</sup> at &lt; 5&#176;C",
		);
		expect(title.querySelector("strong em sub")?.textContent).toBe("2");
		expect(title.querySelector("sup")?.textContent).toBe("2+");
		expect(title.textContent).toBe("H2O & Mn2+ at < 5°C");
	});

	it("keeps TeX inside and alongside HTML formatting", () => {
		const title = renderTitle(
			String.raw`<i>$x<y$</i> and H<sub>2</sub>O with \(\alpha_1\)`,
		);
		expect(title.querySelectorAll(".katex")).toHaveLength(2);
		expect(title.querySelector("i .katex")?.textContent).toContain("<");
		expect(title.querySelector("sub")?.textContent).toBe("2");
		expect(title.querySelector(".katex-error")).toBeNull();
	});

	it("removes active content, links and attributes while retaining inline text", () => {
		const title = renderTitle(
			'<i onclick="alert(1)" style="position:fixed" class="overlay" data-x="1" aria-label="wrong">Safe</i><script>alert(1)</script><img src="https://example.com/track" onerror="alert(1)"><a href="javascript:alert(1)"> title</a><svg onload="alert(1)"></svg>',
		);
		expect(title.textContent).toBe("Safe title");
		expect(title.querySelector("script,img,a,svg")).toBeNull();
		expect(title.querySelector("i")?.attributes.length).toBe(0);
	});

	it("preserves plain scientific text, existing TeX and escaped literal tags", () => {
		expect(renderTitle("A* search: x<y, p < 0.05 & H2O").textContent).toBe(
			"A* search: x<y, p < 0.05 & H2O",
		);
		expect(
			renderTitle("An $x^2$ bound").querySelector(".katex"),
		).not.toBeNull();
		const escaped = renderTitle("&lt;i&gt;literal&lt;/i&gt;");
		expect(escaped.textContent).toBe("<i>literal</i>");
		expect(escaped.querySelector("i")).toBeNull();
	});
});
