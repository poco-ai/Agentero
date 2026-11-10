// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { activateHintTarget } from "@/lib/keyboard/hint-activate";
import {
	assignHintLabels,
	HINT_MODIFIER_KEYS,
	hintKeyFromEvent,
	matchHintLabel,
} from "@/lib/keyboard/hint-labels";
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
		expect(labels.every((label) => !label.includes("f"))).toBe(true);
		expect(labels.every((label) => label.length === 2)).toBe(true);
		expect(matchHintLabel("aa", labels)).toEqual({ kind: "unique", index: 0 });
	});

	it("keeps partial prefixes active and rejects unknown labels", () => {
		const labels = assignHintLabels(28);
		expect(matchHintLabel("a", labels)).toEqual({
			kind: "partial",
			remaining: 25,
		});
		expect(matchHintLabel("z", labels)).toEqual({ kind: "none" });
	});

	it("accepts label keys regardless of Shift and layout", () => {
		expect(hintKeyFromEvent({ key: "a", code: "KeyA" })).toBe("a");
		expect(hintKeyFromEvent({ key: "A", code: "KeyA" })).toBe("a");
		// Shift / Option compose the letter, IME reports Process.
		expect(hintKeyFromEvent({ key: "Å", code: "KeyA" })).toBe("a");
		expect(hintKeyFromEvent({ key: "Process", code: "KeyI" })).toBe("i");
		expect(hintKeyFromEvent({ key: "1", code: "Digit1" })).toBeNull();
		expect(
			hintKeyFromEvent({ key: "Backspace", code: "Backspace" }),
		).toBeNull();
	});

	it("never treats a held modifier as unknown input", () => {
		for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
			expect(HINT_MODIFIER_KEYS.has(key)).toBe(true);
			expect(hintKeyFromEvent({ key, code: `${key}Left` })).toBeNull();
		}
	});

	it("collapses an explicit target's descendants into one row hint", () => {
		document.body.innerHTML = `
			<table><tbody>
				<tr data-hint data-hint-priority="1">
					<td><button>Paper title</button></td>
					<td><button>Star</button></td>
				</tr>
			</tbody></table>
		`;
		const row = document.querySelector("tr") as HTMLElement;
		row.getBoundingClientRect = () => new DOMRect(10, 10, 600, 36);
		for (const button of document.querySelectorAll("button")) {
			button.getBoundingClientRect = () => new DOMRect(12, 12, 100, 20);
		}
		const targets = collectHintTargets(document.body, {
			width: 800,
			height: 600,
		});
		expect(targets).toHaveLength(1);
		expect(targets[0].element).toBe(row);
		expect(targets[0].priority).toBe(1);
	});

	it("finds menu items in floating popups and skips disabled ones", () => {
		document.body.innerHTML = `
			<div role="menu">
				<div role="menuitem">Open</div>
				<div role="menuitem" data-disabled>Disabled</div>
				<div role="menuitemcheckbox">Star</div>
			</div>
		`;
		for (const item of document.querySelectorAll("[role^='menuitem']")) {
			(item as HTMLElement).getBoundingClientRect = () =>
				new DOMRect(10, 10, 120, 24);
		}
		const targets = collectHintTargets(document.body, {
			width: 800,
			height: 600,
		});
		expect(targets.map((target) => target.element.textContent)).toEqual([
			"Open",
			"Star",
		]);
	});

	it("activates pointerdown-only triggers like a real click", () => {
		const button = document.createElement("button");
		const seen: string[] = [];
		for (const type of [
			"pointerdown",
			"mousedown",
			"pointerup",
			"mouseup",
			"click",
		]) {
			button.addEventListener(type, () => seen.push(type));
		}
		document.body.appendChild(button);
		button.getBoundingClientRect = () => new DOMRect(10, 10, 40, 24);
		activateHintTarget(button);
		expect(seen).toEqual([
			"pointerdown",
			"mousedown",
			"pointerup",
			"mouseup",
			"click",
		]);
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
