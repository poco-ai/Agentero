// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/agent/message", () => ({
	MessageResponse: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("motion/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("motion/react")>()),
	useReducedMotion: () => true,
}));

it("expands and restores without losing translation, focus, or pin controls", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const onHide = vi.fn();
	const onTogglePin = vi.fn();
	try {
		await act(() =>
			root.render(
				createElement(TranslateCard, {
					screen: { x: 100, y: 100 },
					result: "Readable translation",
					streaming: false,
					error: null,
					pinned: true,
					onOpenSettings: vi.fn(),
					onHide,
					onTogglePin,
				}),
			),
		);
		const card = container.querySelector<HTMLElement>('[role="dialog"]');
		const expand = container.querySelector<HTMLButtonElement>(
			'[aria-label="selection.translateExpand"]',
		);
		expect(card?.style.resize).toBe("both");
		expect(card?.style.width).toBe("340px");
		await act(() => {
			expand?.focus();
			expand?.click();
		});
		expect(card?.style.width).toBe("680px");
		expect(expand?.getAttribute("aria-label")).toBe(
			"selection.translateRestoreSize",
		);
		expect(document.activeElement).toBe(expand);
		expect(card?.textContent).toContain("Readable translation");
		await act(() => expand?.click());
		expect(card?.style.width).toBe("340px");
		expect(document.activeElement).toBe(expand);
		const pin = container.querySelector<HTMLButtonElement>(
			'[aria-label="selection.translateUnpin"]',
		);
		expect(pin?.getAttribute("aria-pressed")).toBe("true");
		await act(() => pin?.click());
		expect(onTogglePin).toHaveBeenCalledOnce();
		expect(onHide).not.toHaveBeenCalled();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			document.body.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true }),
			);
		});
		expect(onHide).not.toHaveBeenCalled();
		await act(() =>
			container
				.querySelector<HTMLButtonElement>(
					'[aria-label="selection.translateHide"]',
				)
				?.click(),
		);
		expect(onHide).toHaveBeenCalledOnce();
		onHide.mockClear();
		await act(() =>
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
		);
		expect(onHide).toHaveBeenCalledOnce();
	} finally {
		await act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
