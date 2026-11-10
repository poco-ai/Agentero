import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { logger } from "@/lib/core/logger";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import { flushMarkdownSources } from "@/lib/workspace/viewer/markdown-editor-registry";

export function useFlushMarkdownOnClose() {
	useEffect(() => {
		if (!isTauri() || isMobileApp()) return;
		const listener = getCurrentWindow().onCloseRequested(async (event) => {
			try {
				const { flushCloudCheckouts } = await import(
					"@/lib/writing/cloud/session"
				);
				if ((await flushMarkdownSources()) && (await flushCloudCheckouts()))
					return;
			} catch {
				// Keep the document open when the save could not finish.
			}
			event.preventDefault();
		});
		void listener.catch((error) =>
			logger.warn("Could not register window save on close", {
				error: String(error),
			}),
		);
		return () => {
			void listener.then(
				(unlisten) => unlisten(),
				() => {},
			);
		};
	}, []);
}
