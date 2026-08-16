/**
 * Decide whether a prepared brief can enter Voice, and which UI phase to
 * paint before any async work. The React hook must call this, leave
 * `prepare`, then connect — never the other way around.
 */

export type PreparedDefenseEnterRejectReason =
	| "unavailable"
	| "stale"
	| "selection_changed";

export type PreparedDefenseEnterPlan =
	| {
			action: "connect";
			runId: string;
			material: string;
			source: string;
	  }
	| {
			action: "reject";
			reason: PreparedDefenseEnterRejectReason;
	  };

export function planPreparedDefenseEnter(input: {
	vaultPath: string | null | undefined;
	preparation: {
		runId: string;
		stale: boolean;
		briefPath?: string | null;
	} | null;
	context: string;
	materialsMatchSnapshot: boolean;
}): PreparedDefenseEnterPlan {
	const material = input.context.trim();
	if (!input.vaultPath || !input.preparation || !material) {
		return { action: "reject", reason: "unavailable" };
	}
	if (input.preparation.stale) {
		return { action: "reject", reason: "stale" };
	}
	if (!input.materialsMatchSnapshot) {
		return { action: "reject", reason: "selection_changed" };
	}
	return {
		action: "connect",
		runId: input.preparation.runId,
		material,
		source: input.preparation.briefPath ?? "",
	};
}

/** UI phase to apply synchronously when enter is allowed. Reject stays on prepare. */
export function preparedDefenseEnterPhase(
	plan: PreparedDefenseEnterPlan,
): "prepare" | "connecting" {
	return plan.action === "connect" ? "connecting" : "prepare";
}

/**
 * Start Voice first. `confirm` must not run until `connect()` has entered
 * (its synchronous prefix), or a hung confirm can leave the connecting page
 * with no session.
 */
export async function runPreparedDefenseEnter<T>(work: {
	connect: () => Promise<T>;
	confirm?: () => void;
}): Promise<T> {
	const pending = work.connect();
	work.confirm?.();
	return pending;
}
