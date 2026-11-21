/**
 * Pure rules for moving an Agent session from the main window into a new
 * feature window. IO (emit, listen, rebind) lives in `workspace-broadcast`.
 *
 * One snapshot is sent after the target says it is listening. The source
 * retargets in-flight host events only after the target acks that snapshot.
 */

export type HandoffPhase = "waiting-ready" | "snapshot-sent" | "delivered";

export type HandoffDeliveryEffect = "send-snapshot" | "rebind" | "none";

/** Fields the delivery state machine actually reads. */
export type HandoffDeliveryMessage =
	| { kind: "ready"; targetLabel: string }
	| { kind: "snapshot"; targetLabel: string; deliveryId: string }
	| {
			kind: "ack";
			targetLabel: string;
			sourceLabel: string;
			deliveryId: string;
	  };

export function shouldScheduleAgentSessionHandoff(
	view: string,
	existed: boolean,
): boolean {
	// An already-open agent window keeps its own transcript. A snapshot from
	// the main window would replace that live session.
	return view === "agent" && !existed;
}

/**
 * Advance the source window's handoff. `send-snapshot` happens once, after
 * the target is listening. `rebind` happens only after that snapshot is acked.
 */
export function stepHandoffDelivery(
	phase: HandoffPhase,
	message: HandoffDeliveryMessage,
	expected: { targetLabel: string; deliveryId: string },
): { phase: HandoffPhase; effect: HandoffDeliveryEffect } {
	if (phase === "delivered") return { phase, effect: "none" };
	if (message.targetLabel !== expected.targetLabel) {
		return { phase, effect: "none" };
	}
	if (phase === "waiting-ready" && message.kind === "ready") {
		return { phase: "snapshot-sent", effect: "send-snapshot" };
	}
	if (
		phase === "snapshot-sent" &&
		message.kind === "ack" &&
		message.deliveryId === expected.deliveryId
	) {
		return { phase: "delivered", effect: "rebind" };
	}
	return { phase, effect: "none" };
}
