import type { LifecycleEventMap } from "@/lib/lifecycle/events";
import type { SemanticTarget } from "./types";

export type SuggestionTrigger = "paper:assets-ready" | "job:completed";
export type SuggestionStatus =
	| "pending"
	| "dismissed"
	| "snoozed"
	| "expired"
	| "accepted";
export type SuggestionExecutionStatus =
	| "not-started"
	| "running"
	| "succeeded"
	| "failed";

export type NavigatorSuggestion = {
	suggestionId: string;
	trigger: SuggestionTrigger;
	target: SemanticTarget;
	candidateActionId: string;
	reasonKey: string;
	source: "workflow-rule";
	ttlMs: number;
	createdAt: number;
	expiresAt: number;
	workflowId: string;
	resourceRevision?: string;
	intentKey: string;
	status: SuggestionStatus;
	executionStatus: SuggestionExecutionStatus;
	causationId: string;
};

export type SuggestionPreferences = {
	enabled: boolean;
	disabledTriggers: ReadonlySet<SuggestionTrigger>;
	cooldownMs: number;
};

const id = () =>
	`suggestion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class SuggestionCoordinator {
	private readonly suggestions = new Map<string, NavigatorSuggestion>();
	private readonly lastShown = new Map<string, number>();
	private prefs: SuggestionPreferences = {
		enabled: true,
		disabledTriggers: new Set(),
		cooldownMs: 30_000,
	};

	setPreferences(prefs: Partial<SuggestionPreferences>): void {
		this.prefs = { ...this.prefs, ...prefs };
	}
	list(now = Date.now()): NavigatorSuggestion[] {
		this.expire(now);
		return [...this.suggestions.values()].filter(
			(item) => item.status === "pending",
		);
	}
	dismiss(suggestionId: string): void {
		this.setStatus(suggestionId, "dismissed");
	}
	snooze(suggestionId: string, durationMs = 10 * 60_000): void {
		const item = this.suggestions.get(suggestionId);
		if (!item) return;
		item.status = "snoozed";
		this.lastShown.set(item.intentKey, Date.now() + durationMs);
	}
	accept(suggestionId: string): NavigatorSuggestion | null {
		const item = this.suggestions.get(suggestionId);
		if (item?.status !== "pending" || item.expiresAt <= Date.now()) return null;
		item.status = "accepted";
		return { ...item };
	}
	markExecution(suggestionId: string, status: SuggestionExecutionStatus): void {
		const item = this.suggestions.get(suggestionId);
		if (item) item.executionStatus = status;
	}

	onAssetsReady(
		payload: LifecycleEventMap["paper:assets-ready"],
	): NavigatorSuggestion | null {
		if (
			!this.prefs.enabled ||
			this.prefs.disabledTriggers.has("paper:assets-ready")
		)
			return null;
		return this.offer({
			trigger: "paper:assets-ready",
			target: {
				kind: "paper",
				vaultId: payload.vaultId,
				paperId: payload.paperId,
				path: payload.path,
			},
			candidateActionId: "paper.open",
			reasonKey: "navigator.assetsReady",
			workflowId: "paper-assets-ready-open",
			resourceRevision: String(payload.timestamp),
			causationId: `paper:assets-ready:${payload.vaultId}:${payload.paperId}:${payload.timestamp}`,
		});
	}

	onJobCompleted(
		payload: LifecycleEventMap["job:completed"],
	): NavigatorSuggestion | null {
		if (
			!this.prefs.enabled ||
			this.prefs.disabledTriggers.has("job:completed") ||
			!payload.paperId
		)
			return null;
		return this.offer({
			trigger: "job:completed",
			target: {
				kind: "paper",
				vaultId: payload.vaultId,
				paperId: payload.paperId,
			},
			candidateActionId: "paper.open",
			reasonKey: "navigator.jobCompleted",
			workflowId: `job-completed:${payload.kind}`,
			resourceRevision: String(payload.timestamp),
			causationId: `job:completed:${payload.jobId}`,
		});
	}

	private offer(
		input: Omit<
			NavigatorSuggestion,
			| "suggestionId"
			| "source"
			| "ttlMs"
			| "createdAt"
			| "expiresAt"
			| "intentKey"
			| "status"
			| "executionStatus"
		>,
	): NavigatorSuggestion | null {
		const now = Date.now();
		const targetId =
			input.target.kind === "paper" ? input.target.paperId : input.target.kind;
		const intentKey = `${input.workflowId}:${targetId}:${input.candidateActionId}:${input.resourceRevision ?? ""}`;
		if (
			(this.lastShown.get(intentKey) ?? 0) > now ||
			[...this.suggestions.values()].some(
				(item) => item.intentKey === intentKey && item.status === "pending",
			)
		)
			return null;
		const item: NavigatorSuggestion = {
			...input,
			suggestionId: id(),
			source: "workflow-rule",
			ttlMs: 5 * 60_000,
			createdAt: now,
			expiresAt: now + 5 * 60_000,
			intentKey,
			status: "pending",
			executionStatus: "not-started",
		};
		this.suggestions.set(item.suggestionId, item);
		this.lastShown.set(intentKey, now + this.prefs.cooldownMs);
		return { ...item };
	}
	private setStatus(suggestionId: string, status: SuggestionStatus): void {
		const item = this.suggestions.get(suggestionId);
		if (item) item.status = status;
	}
	private expire(now: number): void {
		for (const item of this.suggestions.values())
			if (item.status === "pending" && item.expiresAt <= now)
				item.status = "expired";
	}
}

export const suggestionCoordinator = new SuggestionCoordinator();
