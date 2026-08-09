function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

function hasPendingExportContent(root: HTMLElement): boolean {
	if (root.querySelector('[data-wiki-embed="loading"]')) return true;
	// Attachment / annotation / image placeholders set this while async work runs
	// (parent wiki-embed may already be `ready` before bytes/object URLs exist).
	if (root.querySelector("[data-export-pending]")) return true;
	const images = Array.from(root.querySelectorAll("img"));
	return images.some((img) => !img.complete);
}

/**
 * Wait until export surface embeds and images settle.
 * - no `[data-wiki-embed="loading"]`
 * - no `[data-export-pending]`
 * - all `<img>` complete (or errored)
 * - document fonts ready when available
 * - re-check after a short settle so late-mounted embeds are not missed
 */
export async function waitForExportReady(
	root: HTMLElement,
	opts: { timeoutMs?: number; settleMs?: number } = {},
): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 20_000;
	const settleMs = opts.settleMs ?? 120;
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		if (root.querySelector('[data-wiki-embed="loading"]')) {
			await sleep(40);
			continue;
		}
		if (root.querySelector("[data-export-pending]")) {
			await sleep(40);
			continue;
		}

		const images = Array.from(root.querySelectorAll("img"));
		const pending = images.filter((img) => !img.complete);
		if (pending.length > 0) {
			await Promise.all(
				pending.map(
					(img) =>
						new Promise<void>((resolve) => {
							const done = () => resolve();
							img.addEventListener("load", done, { once: true });
							img.addEventListener("error", done, { once: true });
							// Already finished between filter and listener attach.
							if (img.complete) resolve();
						}),
				),
			);
			continue;
		}

		if (
			typeof document !== "undefined" &&
			document.fonts &&
			document.fonts.status === "loading"
		) {
			try {
				await document.fonts.ready;
			} catch {
				// ignore font readiness failures
			}
		}

		// Two frames + short settle so KaTeX/layout can paint.
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => resolve());
			});
		});
		await sleep(settleMs);

		// Embeds/images may mount during settle — only exit when still quiet.
		if (hasPendingExportContent(root)) continue;
		return;
	}

	throw new Error("export-ready-timeout");
}
