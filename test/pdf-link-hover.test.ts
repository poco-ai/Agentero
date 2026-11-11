// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { textLinkHoverPoint } from "@/components/viewer/pdf/link-hover";

afterEach(() => vi.restoreAllMocks());

it("distinguishes wrapped ranges split across nested text nodes", () => {
	const anchor = document.createElement("a");
	anchor.innerHTML = "[8<span>–11</span>,<span>15–</span>18]";
	vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
		this: Range,
	) {
		const text = this.toString();
		expect(["8–11", "15–18"]).toContain(text);
		return [
			new DOMRect(100, text === "8–11" ? 50 : 75, 40, 18),
		] as unknown as DOMRectList;
	});
	expect(
		textLinkHoverPoint(anchor, { clientX: 120, clientY: 55 }).citation?.range,
	).toEqual({ start: 8, end: 11 });
	expect(
		textLinkHoverPoint(anchor, { clientX: 120, clientY: 80 }).citation?.range,
	).toEqual({ start: 15, end: 18 });
});

it("keeps the correct target when a translated run contains only part of the bracket", () => {
	const anchor = document.createElement("a");
	anchor.textContent = "17]";
	expect(
		textLinkHoverPoint(anchor, undefined, { text: "[1,12,17]", offset: 6 })
			.citation,
	).toEqual({ entry: 17, range: null, entries: [1, 12, 17] });
});

it("does not interpret figure labels or bracketed prose as numbered citations", () => {
	const anchor = document.createElement("a");
	for (const text of ["Fig. 12", "Table 2", "[see 12]"]) {
		anchor.textContent = text;
		expect(textLinkHoverPoint(anchor).citation).toBeUndefined();
	}
});

it("keeps the whole citation across separate annotations and styled runs", () => {
	const anchor = document.createElement("a");
	anchor.textContent = "19";
	const text = "Measurements [18,19] and [21–23,25].";
	const point = textLinkHoverPoint(anchor, undefined, {
		text,
		offset: text.indexOf("19"),
	});
	expect(point.citation?.entries).toEqual([18, 19]);
	anchor.textContent = "23";
	expect(
		textLinkHoverPoint(anchor, undefined, { text, offset: text.indexOf("23") })
			.citation?.entries,
	).toEqual([21, 22, 23, 25]);
});
