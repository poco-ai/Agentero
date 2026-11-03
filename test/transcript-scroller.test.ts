// @vitest-environment happy-dom

import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
	Conversation,
	ConversationContent,
	useConversationViewport,
} from "@/components/agent/conversation";
import { useTranscriptVirtualizer } from "@/components/agent/hooks/use-transcript-virtualizer";
import {
	MessageScrollerContent,
	MessageScrollerItem,
} from "@/components/ui/message-scroller";
import type { ChatLine } from "@/lib/agent/chat-state";

vi.mock("@/lib/settings", () => ({ useUiScale: () => 1 }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => vi.unstubAllGlobals());

it("shares the upstream viewport across the 80-row virtualizing boundary", async () => {
	const observations: Array<{
		viewport: HTMLDivElement | null;
		virtualized: boolean;
		total: number;
	}> = [];
	function Rows({ lines }: { lines: ChatLine[] }) {
		const viewport = useConversationViewport();
		const { virtualized, rowVirtualizer } = useTranscriptVirtualizer({
			lines,
			activeTabId: "session",
		});
		useEffect(() => {
			observations.push({
				viewport: viewport.current,
				virtualized,
				total: rowVirtualizer.getTotalSize(),
			});
		});
		return createElement(
			MessageScrollerContent,
			null,
			virtualized
				? createElement(MessageScrollerItem, {
						messageId: "virtual:session",
						style: { height: rowVirtualizer.getTotalSize() },
					})
				: lines.map((line) =>
						createElement(
							MessageScrollerItem,
							{ key: line.id, messageId: line.id },
							line.kind,
						),
					),
		);
	}
	async function render(count: number) {
		const lines: ChatLine[] = Array.from({ length: count }, (_, index) => ({
			id: String(index),
			kind: "user",
			text: "message",
		}));
		await act(() =>
			root.render(
				createElement(
					Conversation,
					null,
					createElement(
						ConversationContent,
						null,
						createElement(Rows, { lines }),
					),
				),
			),
		);
		return observations.at(-1);
	}
	const short = await render(79);
	expect(short?.virtualized).toBe(false);
	expect(short?.viewport).toBe(
		container.querySelector('[data-slot="message-scroller-viewport"]'),
	);
	const long = await render(81);
	expect(long?.virtualized).toBe(true);
	expect(long?.viewport).toBe(short?.viewport);
	expect(long?.total).toBe(81 * 80);
	expect(
		container.querySelectorAll('[data-slot="message-scroller-content"]'),
	).toHaveLength(1);
	expect(
		container.querySelectorAll('[data-slot="message-scroller-item"]'),
	).toHaveLength(1);
	const shortened = await render(3);
	expect(shortened?.virtualized).toBe(false);
	expect(shortened?.viewport).toBe(short?.viewport);
	await act(() => root.unmount());
	container.remove();
});
