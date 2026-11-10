import { listCommands } from "@/lib/shell/commands/registry";
import {
	contextIsCurrent,
	type NavigatorAction,
	type NavigatorContext,
	NavigatorExecutionError,
	type SemanticTarget,
} from "./types";

const actions = new Map<string, NavigatorAction>();

export function registerNavigatorAction(action: NavigatorAction): () => void {
	if (actions.has(action.id))
		throw new Error(`Navigator action already registered: ${action.id}`);
	actions.set(action.id, action);
	return () => {
		if (actions.get(action.id) === action) actions.delete(action.id);
	};
}

export function getNavigatorAction(id: string): NavigatorAction | undefined {
	return (
		actions.get(id) ??
		listCommands().find((command) => command.id === id)?.navigatorAction
	);
}

export function listNavigatorActions(
	target?: SemanticTarget,
): NavigatorAction[] {
	return [...actions.values()].filter(
		(action) => !target || action.supports(target),
	);
}

export function resetNavigatorActionsForTests(): void {
	actions.clear();
}

export async function executeNavigatorAction(
	id: string,
	target: SemanticTarget,
	context: NavigatorContext,
	current?: () => { target: SemanticTarget; resourceRevision?: string } | null,
): Promise<unknown> {
	const action = getNavigatorAction(id);
	const targetKind = target.kind;
	if (!action)
		throw new NavigatorExecutionError(
			"unregistered-action",
			`Unknown Navigator action: ${id}`,
		);
	if (!action.supports(target)) {
		throw new NavigatorExecutionError(
			"unsupported-target",
			`${id} does not support ${targetKind}`,
		);
	}
	const currentState = current?.();
	if (current && (!currentState || !contextIsCurrent(context, currentState)))
		throw new NavigatorExecutionError(
			"stale-context",
			"Navigator target is no longer available",
		);
	if (!action.isAvailable(target, context)) {
		throw new NavigatorExecutionError(
			"unavailable",
			`Navigator action is unavailable: ${id}`,
		);
	}
	return action.execute(target, context);
}
