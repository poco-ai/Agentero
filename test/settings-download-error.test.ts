import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyReleaseDownloadError } from "@/lib/settings/download-error";
import { openSettingsWindow } from "@/lib/shell/settings-window";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/shell/settings-window", () => ({
	openSettingsWindow: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe("GitHub download errors", () => {
	it.each([
		"error sending request for url (https://github.com/asset)",
		new Error("download body error: request or response body error"),
		new Error("connection refused"),
	])("offers network settings for a transport error", (error) => {
		notifyReleaseDownloadError("Install failed", error);

		expect(toast.error).toHaveBeenCalledTimes(1);
		const [title, options] = vi.mocked(toast.error).mock.calls[0];
		expect(title).toBe("settings:about.downloadNetworkError.title");
		const action = options?.action as { onClick: () => void };
		action.onClick();
		expect(openSettingsWindow).toHaveBeenCalledWith("general");
	});

	it.each([
		"CLI asset not found (404): https://github.com/asset",
		"CLI archive checksum mismatch",
		"Signature verification failed",
	])("keeps the install error for %s", (error) => {
		notifyReleaseDownloadError("Install failed", error, error);

		expect(toast.error).toHaveBeenCalledWith(
			"Install failed",
			expect.objectContaining({ description: error, action: undefined }),
		);
	});
});
