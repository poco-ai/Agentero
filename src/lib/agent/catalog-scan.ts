/**
 * Shared catalog scan.
 *
 * The Agent panel used to run its own scan on mount, on top of the app-start
 * prefetch and one scan per `agent:registry-changed` burst — three full catalog
 * scans for a single app start. A scan probes PATH (and, on macOS, Spotlight)
 * for every template, so sharing one result matters.
 *
 * Concurrent callers join one request, and a short TTL lets the first panel
 * mount reuse the startup scan. Anything that installs, removes or re-probes an
 * agent invalidates the cache; the TTL only bounds how long a CLI installed in
 * another terminal stays invisible.
 */
import { type CatalogScanResponse, scanCatalog } from "@/lib/agent/api";

/** Reuse window for the startup scan before probing PATH again. */
const TTL_MS = 30_000;

let cached: { at: number; value: CatalogScanResponse } | null = null;
let inflight: Promise<CatalogScanResponse> | null = null;
/** Bumped by {@link invalidateCatalogScan}; a request that started before an
 *  invalidation must not write its (already stale) result into the cache. */
let generation = 0;

/**
 * Scan the local catalog, reusing a recent shared result unless `force` is set.
 * `force` is for user-visible waits (CLI login, agent switch) where a cached
 * answer would look stale; Settings and onboarding call `scanCatalog` directly.
 */
export function scanCatalogCached(opts?: {
	force?: boolean;
}): Promise<CatalogScanResponse> {
	if (!opts?.force && cached && Date.now() - cached.at < TTL_MS) {
		return Promise.resolve(cached.value);
	}
	if (inflight) return inflight;
	const startedAt = generation;
	const request = scanCatalog().then((value) => {
		if (generation === startedAt) cached = { at: Date.now(), value };
		return value;
	});
	const tracked = request.finally(() => {
		if (inflight === tracked) inflight = null;
	});
	inflight = tracked;
	return tracked;
}

/** Drop the shared result (registry writes, probes, installers). */
export function invalidateCatalogScan(): void {
	generation += 1;
	cached = null;
	inflight = null;
}
