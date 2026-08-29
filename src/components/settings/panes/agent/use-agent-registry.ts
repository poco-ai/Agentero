import { useCallback, useEffect, useState } from "react";
import { type CatalogScanResponse, listAgents } from "@/lib/agent";
import { isTauri } from "@/lib/core/tauri";

/**
 * listAgents registry backing the agent/model pickers; refreshes when the
 * catalog scan changes (installs / removals / probes mutate the registry).
 */
export function useAgentRegistry(catalog: CatalogScanResponse | null) {
	const [registry, setRegistry] = useState<Awaited<
		ReturnType<typeof listAgents>
	> | null>(null);

	const refresh = useCallback(async () => {
		if (!isTauri()) {
			setRegistry(null);
			return;
		}
		try {
			setRegistry(await listAgents());
		} catch {
			setRegistry(null);
		}
	}, []);

	// Registry for PDF Ask agent/model selects (refresh when catalog changes)
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-load after rescan/probe updates catalog
	useEffect(() => {
		void refresh();
	}, [catalog, refresh]);

	return { registry, refresh };
}
