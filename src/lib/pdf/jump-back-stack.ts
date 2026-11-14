/**
 * Origin-position stack for internal PDF link jumps (citation, cross-ref,
 * appendix …) — the "jump back" affordance (issue #505).
 *
 * Pure logic so the viewer hook stays thin and the stack behaviour
 * (dedupe / depth cap / pop order) is unit-testable without EmbedPDF.
 */

/** A pre-jump reading of the viewport. `page` is 1-based (display + i18n). */
export type JumpOrigin = {
	x: number;
	y: number;
	page: number;
	/** Reflowed text has its own scroll geometry, independent of the PDF. */
	reader?: { blockId: string | null; top: number; scrollTop: number };
};

/** Max remembered origins per document; further jumps drop the oldest. */
export const JUMP_BACK_STACK_MAX = 20;

/**
 * Push an origin unless it is a near-duplicate of the current top (same page,
 * sub-threshold offset) — clicking the same link twice must not stack two
 * copies of one position.
 */
export const JUMP_BACK_DEDUPE_DISTANCE_PX = 50;

export type JumpBackStack = {
	readonly entries: readonly JumpOrigin[];
};

export function createJumpBackStack(): JumpBackStack {
	return { entries: [] };
}

function distance(a: JumpOrigin, b: JumpOrigin): number {
	if (!!a.reader !== !!b.reader) return Number.POSITIVE_INFINITY;
	if (a.reader && b.reader)
		return Math.abs(a.reader.scrollTop - b.reader.scrollTop);
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Push, deduping against the top and capping the depth. Returns the stack. */
export function pushJumpOrigin(
	stack: JumpBackStack,
	origin: JumpOrigin,
): JumpBackStack {
	const top = stack.entries[stack.entries.length - 1];
	if (
		top &&
		top.page === origin.page &&
		distance(top, origin) < JUMP_BACK_DEDUPE_DISTANCE_PX
	) {
		return stack;
	}
	const entries = [...stack.entries, origin];
	if (entries.length > JUMP_BACK_STACK_MAX) entries.shift();
	return { entries };
}

/** Pop the newest origin. Returns null when the stack is empty. */
export function popJumpOrigin(
	stack: JumpBackStack,
): { stack: JumpBackStack; origin: JumpOrigin } | null {
	if (stack.entries.length === 0) return null;
	const entries = [...stack.entries];
	const origin = entries.pop() as JumpOrigin;
	return { stack: { entries }, origin };
}

/** The origin a "jump back" chip would restore, without popping. */
export function peekJumpOrigin(stack: JumpBackStack): JumpOrigin | null {
	return stack.entries[stack.entries.length - 1] ?? null;
}
