export type SemanticTarget =
	| { kind: "paper"; vaultId: string; paperId: string; path?: string }
	| { kind: "file"; vaultId: string; fileId: string; path?: string }
	| {
			kind: "pdf-anchor";
			vaultId: string;
			paperId: string;
			page: number;
			anchor: string;
	  }
	| {
			kind: "selection";
			panelId: string;
			snapshotId: string;
			paperId?: string;
	  };

/** DOM-only and session-scoped; never serialise this as a semantic target. */
export type UIHintTarget = {
	kind: "ui-control";
	windowId: string;
	elementId: string;
};

export type NavigatorContext = {
	target: SemanticTarget;
	sourcePanelId?: string;
	agentSessionId?: string;
	capturedAt: string;
	resourceRevision?: string;
	contextFingerprint?: string;
};

export type NavigatorContextSnapshot = NavigatorContext & {
	readonly contextFingerprint: string;
};

export type NavigatorEffect =
	| "read"
	| "write"
	| "network"
	| "cost"
	| "destructive";
export type NavigatorConfirmation = "never" | "on-suggestion" | "always";

export type NavigatorAction<T extends SemanticTarget = SemanticTarget> = {
	id: string;
	supports: (target: SemanticTarget) => target is T;
	isAvailable: (target: T, context: NavigatorContext) => boolean;
	effects: readonly NavigatorEffect[];
	confirmation: NavigatorConfirmation;
	execute: (target: T, context: NavigatorContext) => Promise<unknown>;
};

export type NavigatorExecutionErrorCode =
	| "unsupported-target"
	| "unavailable"
	| "stale-context"
	| "unregistered-action";

export class NavigatorExecutionError extends Error {
	readonly code: NavigatorExecutionErrorCode;
	constructor(code: NavigatorExecutionErrorCode, message: string) {
		super(message);
		this.name = "NavigatorExecutionError";
		this.code = code;
	}
}

export function semanticTargetKey(target: SemanticTarget): string {
	switch (target.kind) {
		case "paper":
			return `paper:${target.vaultId}:${target.paperId}`;
		case "file":
			return `file:${target.vaultId}:${target.fileId}`;
		case "pdf-anchor":
			return `pdf-anchor:${target.vaultId}:${target.paperId}:${target.page}:${target.anchor}`;
		case "selection":
			return `selection:${target.panelId}:${target.snapshotId}`;
	}
}

export function contextFingerprint(context: NavigatorContext): string {
	return [
		semanticTargetKey(context.target),
		context.sourcePanelId ?? "",
		context.agentSessionId ?? "",
		context.resourceRevision ?? "",
	].join("\u0000");
}

export function contextIsCurrent(
	context: NavigatorContext,
	current: { target: SemanticTarget; resourceRevision?: string },
): boolean {
	return (
		semanticTargetKey(context.target) === semanticTargetKey(current.target) &&
		(context.resourceRevision === undefined ||
			context.resourceRevision === current.resourceRevision)
	);
}
