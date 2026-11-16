import { beforeEach, describe, expect, it, vi } from "vitest";

/** Stand-in for Tauri's `Channel`: the Host "sends" by calling `onmessage`. */
class FakeChannel {
	static latest: FakeChannel | null = null;
	onmessage: ((chunk: string) => void) | null = null;
	constructor() {
		FakeChannel.latest = this;
	}
}

const host = vi.hoisted(() => ({
	translateText: vi.fn(),
	translateTextStream: vi.fn(),
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => ({ commands: host }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: FakeChannel }));

// Import after the mocks so the module picks them up.
const { invokeTranslateText } = await import("@/lib/translate/api");

const args = {
	text: "hello",
	sourceLang: "en",
	targetLang: "zh-CN",
	provider: "indextranslate",
};

beforeEach(() => {
	host.translateText.mockReset();
	host.translateTextStream.mockReset();
	host.translateText.mockResolvedValue({
		ok: true,
		data: { text: "你好", provider: "indextranslate" },
	});
	host.translateTextStream.mockResolvedValue({
		ok: true,
		data: { text: "你好", provider: "indextranslate" },
	});
});

describe("invokeTranslateText streaming dispatch", () => {
	it("uses the one-shot command without onDelta", async () => {
		await expect(invokeTranslateText(args)).resolves.toBe("你好");
		expect(host.translateText).toHaveBeenCalledTimes(1);
		expect(host.translateTextStream).not.toHaveBeenCalled();
	});

	it("uses the streaming command and forwards deltas through the channel", async () => {
		const chunks: string[] = [];
		await invokeTranslateText({ ...args, onDelta: (c) => chunks.push(c) });

		expect(host.translateText).not.toHaveBeenCalled();
		expect(host.translateTextStream).toHaveBeenCalledTimes(1);
		const channel = FakeChannel.latest;
		expect(channel).not.toBeNull();
		channel?.onmessage?.("你");
		channel?.onmessage?.("好");
		expect(chunks).toEqual(["你", "好"]);
	});

	it("surfaces a stream error instead of a partial result", async () => {
		host.translateTextStream.mockResolvedValue({
			ok: false,
			error: { code: "translate.no_builtin_key", message: "no key" },
		});
		await expect(
			invokeTranslateText({ ...args, onDelta: () => {} }),
		).rejects.toThrow("translate.no_builtin_key");
	});
});
