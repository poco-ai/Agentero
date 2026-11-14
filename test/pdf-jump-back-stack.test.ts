// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { usePdfJumpBack } from "@/components/viewer/pdf/hooks/use-pdf-jump-back";
import {
	createJumpBackStack,
	JUMP_BACK_DEDUPE_DISTANCE_PX,
	JUMP_BACK_STACK_MAX,
	peekJumpOrigin,
	popJumpOrigin,
	pushJumpOrigin,
} from "@/lib/pdf/jump-back-stack";

const restore = vi.hoisted(() => ({ page: vi.fn(), position: vi.fn() }));
vi.mock("@embedpdf/plugin-scroll/react", () => ({
	useScrollCapability: () => ({
		provides: {
			forDocument: () => ({
				getCurrentPage: () => 2,
				scrollToPage: restore.page,
			}),
		},
	}),
}));
vi.mock("@embedpdf/plugin-viewport/react", () => ({
	useViewportCapability: () => ({
		provides: {
			forDocument: () => ({
				getMetrics: () => ({ scrollLeft: 25, scrollTop: 850 }),
				scrollTo: restore.position,
			}),
		},
	}),
}));

it("restores the scroll plugin's current page before the exact viewport position", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	let view: ReturnType<typeof usePdfJumpBack>;
	function Viewer() {
		view = usePdfJumpBack({ docId: "paper" });
		return null;
	}
	const root = createRoot(document.createElement("div"));
	await act(() => root.render(createElement(Viewer)));
	await act(() => {
		view.captureJumpOrigin();
		view.commitJumpOrigin();
	});
	await act(() => view.goBack());
	expect(restore.page).toHaveBeenCalledWith({
		pageNumber: 2,
		behavior: "instant",
	});
	expect(restore.position).toHaveBeenCalledWith({
		x: 25,
		y: 850,
		behavior: "instant",
	});
	expect(restore.page.mock.invocationCallOrder[0]).toBeLessThan(
		restore.position.mock.invocationCallOrder[0],
	);
	await act(() => root.unmount());
	vi.unstubAllGlobals();
});

describe("jump back stack", () => {
	it("pushes and pops in LIFO order", () => {
		let stack = createJumpBackStack();
		stack = pushJumpOrigin(stack, { x: 0, y: 0, page: 3 });
		stack = pushJumpOrigin(stack, { x: 0, y: 5000, page: 12 });

		const first = popJumpOrigin(stack);
		expect(first?.origin).toEqual({ x: 0, y: 5000, page: 12 });
		const second = popJumpOrigin(first?.stack ?? stack);
		expect(second?.origin).toEqual({ x: 0, y: 0, page: 3 });
		expect(popJumpOrigin(second?.stack ?? stack)).toBeNull();
	});

	it("peek returns the newest origin without popping", () => {
		let stack = createJumpBackStack();
		expect(peekJumpOrigin(stack)).toBeNull();
		stack = pushJumpOrigin(stack, { x: 10, y: 20, page: 4 });
		expect(peekJumpOrigin(stack)).toEqual({ x: 10, y: 20, page: 4 });
		expect(peekJumpOrigin(stack)).toEqual({ x: 10, y: 20, page: 4 });
		expect(stack.entries).toHaveLength(1);
	});

	it("skips a near-duplicate of the current top", () => {
		let stack = createJumpBackStack();
		stack = pushJumpOrigin(stack, { x: 100, y: 200, page: 5 });
		stack = pushJumpOrigin(stack, {
			x: 100 + JUMP_BACK_DEDUPE_DISTANCE_PX - 1,
			y: 200,
			page: 5,
		});
		expect(stack.entries).toHaveLength(1);

		// Same distance on a different page is a distinct origin.
		stack = pushJumpOrigin(stack, {
			x: 100 + JUMP_BACK_DEDUPE_DISTANCE_PX - 1,
			y: 200,
			page: 6,
		});
		expect(stack.entries).toHaveLength(2);
	});

	it("drops the oldest entry past the depth cap", () => {
		let stack = createJumpBackStack();
		for (let i = 0; i < JUMP_BACK_STACK_MAX + 5; i++) {
			stack = pushJumpOrigin(stack, { x: 0, y: i * 1000, page: i + 1 });
		}
		expect(stack.entries).toHaveLength(JUMP_BACK_STACK_MAX);
		// The first pushed origins fell off; the newest is still on top.
		expect(peekJumpOrigin(stack)?.page).toBe(JUMP_BACK_STACK_MAX + 5);
		expect(stack.entries[0]?.page).toBe(6);
	});

	it("never mutates the input stack (safe for React state)", () => {
		const stack = createJumpBackStack();
		const pushed = pushJumpOrigin(stack, { x: 0, y: 0, page: 1 });
		expect(stack.entries).toHaveLength(0);
		expect(pushed.entries).toHaveLength(1);
		const popped = popJumpOrigin(pushed) ?? { stack: pushed, origin: null };
		expect(pushed.entries).toHaveLength(1);
		expect(popped.stack.entries).toHaveLength(0);
	});
});
