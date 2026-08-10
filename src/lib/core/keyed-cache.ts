/**
 * Module-level cache keyed by a request string, with insertion-order eviction
 * and in-flight request de-duplication.
 *
 * Wiki embeds, annotation refs and attachment bytes all need the same three
 * behaviours: serve a warm value synchronously on mount, collapse concurrent
 * loads of one key into a single request, and bound memory. Only the retention
 * policy differs, so that is supplied by the caller.
 */
export type KeyedCache<T> = {
	/** Warm value, if any. Safe to call during render. */
	get(key: string): T | undefined;
	retain(key: string, value: T): void;
	/**
	 * Resolve `key`, reusing a warm value or an in-flight request. Whatever
	 * resolves is offered to `retain`.
	 */
	load(key: string, fetch: () => Promise<T>): Promise<T>;
};

export function createKeyedCache<T>({
	limit,
	shouldRetain,
	isFresh,
}: {
	limit: number;
	/** Return false to skip caching a value, e.g. transient or miss states. */
	shouldRetain?: (value: T) => boolean;
	/** Return false when a warm value must not satisfy a load. */
	isFresh?: (value: T) => boolean;
}): KeyedCache<T> {
	const values = new Map<string, T>();
	const pending = new Map<string, Promise<T>>();

	function retain(key: string, value: T): void {
		if (shouldRetain && !shouldRetain(value)) return;
		// Re-insert so Map iteration order stays least-recently-retained first.
		values.delete(key);
		values.set(key, value);
		while (values.size > limit) {
			const oldest = values.keys().next().value;
			if (typeof oldest !== "string") break;
			values.delete(oldest);
		}
	}

	return {
		get: (key) => values.get(key),
		retain,
		load(key, fetch) {
			const cached = values.get(key);
			if (cached !== undefined && (!isFresh || isFresh(cached))) {
				return Promise.resolve(cached);
			}
			const inFlight = pending.get(key);
			if (inFlight) return inFlight;

			const request = fetch()
				.then((value) => {
					retain(key, value);
					return value;
				})
				.finally(() => {
					pending.delete(key);
				});
			pending.set(key, request);
			return request;
		},
	};
}
