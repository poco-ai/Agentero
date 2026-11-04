// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackfillPrompt } from "@/components/paper/backfill-prompt";
import { DoctorBackfillSection } from "@/components/settings/panes/doctor-backfill-section";
import type { BackfillPreview } from "@/lib/core/bindings";
import {
	dismissPaperBackfill,
	enqueuePaperBackfill,
	maybeShowPaperBackfill,
} from "@/lib/paper/backfill";

const mocks = vi.hoisted(() => ({
	preview: vi.fn(),
	enqueue: vi.fn(),
	custom: vi.fn(),
	dismiss: vi.fn(),
}));
vi.mock("@/lib/core/bindings", () => ({
	commands: {
		jobBackfillPreview: mocks.preview,
		jobBackfillEnqueue: mocks.enqueue,
	},
}));
vi.mock("@/lib/core/ipc", () => ({
	callApiResult: (fn: () => unknown) => fn(),
}));
vi.mock("sonner", () => ({
	toast: { custom: mocks.custom, dismiss: mocks.dismiss },
}));
vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
	notifySuccess: vi.fn(),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const preview: BackfillPreview = {
	downloadSource: 1,
	parseBody: 1,
	repairState: 1,
	papers: [
		{ path: "papers/source", title: "Source", reason: "downloadSource" },
		{ path: "papers/pdf", title: "PDF", reason: "parseBody" },
		{ path: "papers/tex", title: "TeX", reason: "repairState" },
	],
};
afterEach(() => {
	vi.clearAllMocks();
	document.body.replaceChildren();
});

describe("paper backfill consent", () => {
	it("only an explicit Later defers automatic prompts for the session", async () => {
		mocks.preview.mockResolvedValue(preview);
		await maybeShowPaperBackfill("/consent");
		expect(mocks.custom).toHaveBeenCalledTimes(1);
		expect(mocks.enqueue).not.toHaveBeenCalled();
		const prompt = mocks.custom.mock.calls[0][0]();
		prompt.props.onLater();
		await maybeShowPaperBackfill("/consent");
		expect(mocks.preview).toHaveBeenCalledTimes(1);
		expect(mocks.enqueue).not.toHaveBeenCalled();
		mocks.enqueue.mockResolvedValue(1);
		await enqueuePaperBackfill("/consent", ["papers/pdf"]);
		expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
			vaultPath: "/consent",
			paths: ["papers/pdf"],
		});
	});

	it("discards an in-flight preview when its vault closes", async () => {
		let resolve!: (value: BackfillPreview) => void;
		mocks.preview.mockReturnValue(
			new Promise<BackfillPreview>((done) => {
				resolve = done;
			}),
		);
		const pending = maybeShowPaperBackfill("/closed");
		dismissPaperBackfill("/closed");
		resolve(preview);
		await pending;
		expect(mocks.custom).not.toHaveBeenCalled();
		mocks.preview.mockResolvedValue(preview);
		await maybeShowPaperBackfill("/closed");
		expect(mocks.custom).toHaveBeenCalledTimes(1);
	});

	it("checks again when switching back without choosing Later", async () => {
		mocks.preview.mockResolvedValue(preview);
		await maybeShowPaperBackfill("/switch-a");
		dismissPaperBackfill("/switch-a");
		await maybeShowPaperBackfill("/switch-b");
		dismissPaperBackfill("/switch-b");
		await maybeShowPaperBackfill("/switch-a");
		expect(mocks.preview).toHaveBeenCalledTimes(3);
		expect(mocks.custom).toHaveBeenCalledTimes(3);
	});

	it("does not suppress a later activation after an empty preview", async () => {
		mocks.preview.mockResolvedValueOnce({
			papers: [],
			downloadSource: 0,
			parseBody: 0,
			repairState: 0,
		});
		await maybeShowPaperBackfill("/initially-empty");
		expect(mocks.custom).not.toHaveBeenCalled();
		dismissPaperBackfill("/initially-empty");
		mocks.preview.mockResolvedValue(preview);
		await maybeShowPaperBackfill("/initially-empty");
		expect(mocks.custom).toHaveBeenCalledTimes(1);
	});

	it("disables an empty selection and submits only checked costly papers", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const onStart = vi.fn().mockResolvedValue(undefined);
		await act(async () =>
			root.render(
				createElement(BackfillPrompt, { preview, onStart, onLater: vi.fn() }),
			),
		);
		const button = (key: string) => {
			const found = [...host.querySelectorAll("button")].find((node) =>
				node.textContent?.includes(key),
			);
			if (!found) throw new Error(`Missing button: ${key}`);
			return found;
		};
		await act(async () => button("selection").click());
		expect(host.textContent).not.toContain("TeX");
		const checks = () => [
			...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'),
		];
		await act(async () => checks()[0].click());
		expect(button("start").disabled).toBe(true);
		await act(async () => checks()[2].click());
		expect(button("start").disabled).toBe(false);
		await act(async () => button("start").click());
		expect(onStart).toHaveBeenCalledExactlyOnceWith(["papers/pdf"]);
		await act(async () => root.unmount());
	});
});

describe("Doctor paper backfill", () => {
	it("checks into an inline list and enqueues only checked papers without opening a toast prompt", async () => {
		mocks.preview.mockResolvedValue(preview);
		mocks.enqueue.mockResolvedValue(1);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () =>
			root.render(
				createElement(DoctorBackfillSection, { vaultPath: "/doctor" }),
			),
		);
		const button = (key: string) => {
			const found = [...host.querySelectorAll("button")].find((node) =>
				node.textContent?.includes(key),
			);
			if (!found) throw new Error(`Missing button: ${key}`);
			return found;
		};
		expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
		await act(async () => button("backfill.check").click());
		expect(mocks.custom).not.toHaveBeenCalled();
		expect(host.querySelector('[role="dialog"]')).toBeNull();
		const checks = () => [
			...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'),
		];
		expect(checks()).toHaveLength(3);
		await act(async () => checks()[0].click());
		expect(button("backfill.start").disabled).toBe(true);
		await act(async () => checks()[2].click());
		await act(async () => button("backfill.start").click());
		expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
			vaultPath: "/doctor",
			paths: ["papers/pdf"],
		});
		expect(mocks.custom).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});
});
