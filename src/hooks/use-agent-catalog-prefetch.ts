/**
 * Kick catalog ACP soft-probe at app open so the Agent switcher is ready
 * before the lazy sidebar panel mounts.
 */
import { useEffect } from "react";
import { invalidateCatalogScan } from "@/lib/agent/catalog-scan";
import { prefetchAgentCatalog } from "@/lib/agent/prefetch-catalog";
import { lifecycle } from "@/lib/lifecycle";

export function useAgentCatalogPrefetch(): void {
	useEffect(() => {
		prefetchAgentCatalog();
		// Probes/installs rewrite the registry. Invalidate app-wide as well: the
		// panel can be unmounted (popped out to its own window) while the shared
		// scan is still cached, so its own listener would miss the event.
		return lifecycle.on("agent:registry-changed", () => {
			invalidateCatalogScan();
		});
	}, []);
}
