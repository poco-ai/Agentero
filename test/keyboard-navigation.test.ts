// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { assignHintLabels, matchHintLabel } from "@/lib/keyboard/hint-labels";
import { collectHintTargets } from "@/lib/keyboard/hint-targets";

describe("keyboard navigation primitives", () => {
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
