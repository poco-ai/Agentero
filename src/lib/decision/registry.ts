/**
 * Frontend-local decision registry.
 *
 * Pure-rule decisions (file-tree clicks, UI state switches) are deterministic
 * and depend only on in-memory React state, so they run synchronously in the
 * WebView instead of round-tripping to the Host. Semantic decisions (jEV/LLM)
 * live in the Rust decision layer but are not currently exposed to the frontend.
 */

/** A deterministic rule: `state -> Some(action)` stops the chain. */
export type LocalDecisionRule<S> = (state: S) => string | null;

export type LocalDecision<S> = {
	/** Stable decision id, e.g. `file-tree.click`. */
	id: string;
	/** Human-readable summary (debugging only). */
	description: string;
	/** Evaluated in order; the first non-null result wins. */
	rules: LocalDecisionRule<S>[];
	/** Returned when no rule matches. */
	defaultAction: string;
};

type StoredDecision = {
	rules: Array<(state: unknown) => string | null>;
	defaultAction: string;
};

const registry = new Map<string, StoredDecision>();

/** Register (or replace) a local synchronous decision. */
export function registerDecision<S>(decision: LocalDecision<S>): void {
	registry.set(decision.id, {
		rules: decision.rules as Array<(state: unknown) => string | null>,
		defaultAction: decision.defaultAction,
	});
}

/**
 * Evaluate a local decision synchronously. Unknown ids and unmatched states
 * resolve to `"noop"` so callers can switch without a null check.
 */
export function decideSync<S>(decisionId: string, state: S): string {
	const decision = registry.get(decisionId);
	if (!decision) return "noop";
	for (const rule of decision.rules) {
		const action = rule(state);
		if (action) return action;
	}
	return decision.defaultAction;
}
