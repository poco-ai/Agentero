function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

/**
 * Wait until export surface embeds and images settle.
 * - no `[data-wiki-embed="loading"]`
 * - all `<img>` complete (or errored)
 * - document fonts ready when available
 */
export async function waitForExportReady(
	root: HTMLElement,
	opts: { timeoutMs?: number; settleMs?: number } = {},
): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 20_000;
	const settleMs = opts.settleMs ?? 120;
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const loading = root.querySelector('[data-wiki-embed="loading"]');
		if (loading) {
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
		return;
	}

	throw new Error("export-ready-timeout");
}
