import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), session: vi.fn() }));
vi.mock("tauri-plugin-better-auth/client", () => ({ tauriFetch: mocks.fetch }));
vi.mock("@/features/account/visibility", () => ({
	accountSurfaceEnabled: true,
}));
vi.mock("@/features/account/client", () => ({
	accountApiOrigin: "https://account.test",
	authClient: { getSession: mocks.session },
}));
const { hostedTranslation, capabilityRequest } = await import(
	"@/features/capabilities/data"
);

const storage = new Map<string, string>();
beforeEach(() => {
	vi.resetAllMocks();
	storage.clear();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	mocks.session.mockResolvedValue({ data: { user: { id: "user-1" } } });
});

describe("hosted capabilities", () => {
	it("recovers the same intent after a lost response without storing source text", async () => {
		mocks.fetch.mockRejectedValueOnce(new Error("connection reset"));
		await expect(
			hostedTranslation("Private research text", "en", "zh-CN"),
		).rejects.toThrow("connection reset");
		const first = mocks.fetch.mock.calls[0][1];
		expect(storage.size).toBe(1);
		expect(JSON.stringify([...storage])).not.toContain("Private research text");
		mocks.fetch.mockResolvedValueOnce(
			Response.json({
				ok: true,
				data: {
					operation_id: "op-1",
					status: "succeeded",
					billing_status: "settled",
					result: {
						segments: [{ id: "text", status: "succeeded", text: "研究" }],
					},
				},
			}),
		);
		await expect(
			hostedTranslation("Private research text", "en", "zh-CN"),
		).resolves.toBe("研究");
		expect(mocks.fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe(
			first.headers["Idempotency-Key"],
		);
		expect(storage.size).toBe(0);
	});

	it("requires a session before submitting or persisting an intent", async () => {
		mocks.session.mockResolvedValue({ data: null });
		await expect(hostedTranslation("hello", "en", "zh")).rejects.toThrow(
			"CAPABILITY_SIGN_IN_REQUIRED",
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(storage.size).toBe(0);
	});

	it("preserves server revision conflicts and encodes organization identity", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json(
				{
					ok: false,
					error: {
						code: "PREFERENCE_REVISION_CONFLICT",
						message: "Refresh settings",
					},
				},
				{ status: 409 },
			),
		);
		await expect(
			capabilityRequest("org/a", "/spending", { method: "PATCH" }),
		).rejects.toMatchObject({ code: "PREFERENCE_REVISION_CONFLICT" });
		expect(mocks.fetch.mock.calls[0][0]).toBe(
			"https://account.test/api/orgs/org%2Fa/capabilities/spending",
		);
	});
});
