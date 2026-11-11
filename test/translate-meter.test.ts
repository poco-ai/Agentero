// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTranslateMeter } from "@/components/viewer/pdf/hooks/use-translate-meter";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root | null = null;
let latest: ReturnType<typeof useTranslateMeter> | null = null;
const container = document.createElement("div");
document.body.append(container);

function Probe({ running, progress }: { running: boolean; progress: number }) {
	latest = useTranslateMeter({
		layoutTranslateRunning: running,
		layoutTranslateProgress: progress,
	});
	return null;
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	latest = null;
	vi.unstubAllGlobals();
});

it("shows 100% with the completed caption before the spring catches up", async () => {
	await act(async () => {
		root?.render(createElement(Probe, { running: true, progress: 0 }));
	});
	expect(latest?.percent).toBe(0);
	await act(async () => {
		root?.render(createElement(Probe, { running: false, progress: 1 }));
	});
	expect(latest?.lingerFull).toBe(true);
	expect(latest?.stage).toBe("pdf.layoutTranslate.phaseDone");
	expect(latest?.percent).toBe(100);
	expect(latest?.width.get()).toBe("100%");
});
