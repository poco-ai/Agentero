// @vitest-environment happy-dom

import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RailPeek } from "@/components/viewer/pdf/viewport/rail-peek";

let viewport: HTMLDivElement;
vi.mock("@embedpdf/plugin-viewport/react", () => ({
	useViewportElement: () => ({ current: viewport }),
}));

let root: Root | null = null;
afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

it("does not peek again until the pointer leaves the comment trigger after zoom", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	const host = document.createElement("div");
	viewport = document.createElement("div");
	viewport.getBoundingClientRect = () => new DOMRect(0, 0, 900, 800);
	Object.defineProperties(viewport, {
		clientWidth: { value: 900 },
		scrollWidth: { value: 1200 },
	});
	const page = document.createElement("div");
	page.setAttribute("data-embed-pdf-page", "0");
	page.getBoundingClientRect = () => new DOMRect(0, 0, 890, 800);
	host.append(viewport, page);
	document.body.append(host);
	const scrollTo = vi.fn();
	viewport.scrollTo = scrollTo;
	const hostRef = createRef<HTMLDivElement>();
	hostRef.current = host;
	root = createRoot(document.createElement("div"));
	await act(async () =>
		root?.render(
			createElement(RailPeek, {
				hostRef,
				railWidth: 212,
				hasCommentsOnPage: () => true,
			}),
		),
	);

	await act(async () => {
		viewport.dispatchEvent(new Event("pdf-zoom-start"));
		viewport.dispatchEvent(
			new PointerEvent("pointermove", { clientX: 500, clientY: 400 }),
		);
		viewport.dispatchEvent(
			new PointerEvent("pointermove", { clientX: 890, clientY: 400 }),
		);
		vi.advanceTimersByTime(1000);
	});
	expect(scrollTo).not.toHaveBeenCalled();
	await act(async () => {
		viewport.dispatchEvent(new Event("pdf-zoom-settled"));
	});

	await act(async () => {
		viewport.dispatchEvent(
			new PointerEvent("pointermove", { clientX: 500, clientY: 400 }),
		);
		viewport.dispatchEvent(
			new PointerEvent("pointermove", { clientX: 890, clientY: 400 }),
		);
		vi.advanceTimersByTime(400);
	});
	expect(scrollTo).toHaveBeenCalledWith({ left: 210, behavior: "smooth" });
});
