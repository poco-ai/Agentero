// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { assignHintLabels, matchHintLabel } from "@/lib/keyboard/hint-labels";
import { collectHintTargets } from "@/lib/keyboard/hint-targets";
import { PdfKeySequence } from "@/lib/keyboard/pdf-key-sequence";

describe("keyboard navigation primitives", () => {
	it("parses page sequences with renewed deadlines and cancellation", () => {
		const parser = new PdfKeySequence();
		parser.feed("1", 0);
		parser.feed("2", 1000);
		expect(parser.feed("G", 1800).page).toBe(12);
		parser.feed("g", 2000);
		expect(parser.feed("g", 2100).page).toBe(1);
		parser.feed("4", 3000);
		expect(parser.feed("G", 5000).page).toBe("last");
		parser.feed("2", 6000);
		parser.reset();
		expect(parser.feed("G", 6100).page).toBe("last");
	});
	it("excludes controls inside ignored, inert, and editable ancestors", () => {
		document.body.innerHTML = `<div data-hint-ignore><button>Ignore</button></div><div inert><button>Inert</button></div><div contenteditable="true"><button>Edit</button></div>`;
		for (const button of document.querySelectorAll("button")) {
			button.getBoundingClientRect = () => new DOMRect(10, 10, 40, 24);
		}
		expect(collectHintTargets(document.body)).toEqual([]);
	});
	it("uses one label width so prefixes never collide", () => {
		const labels = assignHintLabels(28);
		expect(labels).toHaveLength(28);
		expect(labels[0]).toBe("aa");
		expect(labels.every((label) => label.length === 2)).toBe(true);
		expect(matchHintLabel("aa", labels)).toEqual({ kind: "unique", index: 0 });
	});

	it("keeps partial prefixes active and rejects unknown labels", () => {
		const labels = assignHintLabels(28);
		expect(matchHintLabel("a", labels)).toEqual({
			kind: "partial",
			remaining: 26,
		});
		expect(matchHintLabel("z", labels)).toEqual({ kind: "none" });
	});

	it("filters disabled, hidden, editable, and out-of-viewport controls", () => {
		document.body.innerHTML = `
			<button data-hint data-hint-priority="1">Primary</button>
			<button disabled>Disabled</button>
			<button hidden>Hidden</button>
			<input value="text" />
			<canvas></canvas>
		`;
		const buttons = Array.from(document.querySelectorAll("button"));
		for (const [index, button] of buttons.entries()) {
			Object.defineProperty(button, "getBoundingClientRect", {
				value: () =>
					index === 0
						? new DOMRect(10, 10, 40, 24)
						: new DOMRect(10, 10, 40, 24),
			});
		}
		const targets = collectHintTargets(document.body, {
			width: 800,
			height: 600,
		});
		expect(targets).toHaveLength(1);
		expect(targets[0].element.textContent).toBe("Primary");
		expect(targets[0].priority).toBe(1);
	});
});
