import { commands } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";

export type DecisionGatewayInput = {
	requestId: string;
	stateVersion: string;
	state: Record<string, unknown>;
	targetIdentity: string;
	contextIdentity: string;
	allowedActionIds: string[];
};

export async function requestPdfSelectionIntent(
	input: DecisionGatewayInput,
): Promise<{
	recommendation: string | null;
	allowedActionIds: string[];
	traceId: string;
}> {
	if (!isTauri()) {
		return {
			recommendation: null,
			allowedActionIds: input.allowedActionIds,
			traceId: `navigator:${input.requestId}`,
		};
	}
	const result = await commands.decisionGatewayDecide({
		requestId: input.requestId,
		decisionId: "pdf.selection.intent",
		stateVersion: input.stateVersion,
		state: input.state as never,
		targetIdentity: input.targetIdentity,
		contextIdentity: input.contextIdentity,
		allowedActionIds: input.allowedActionIds,
	});
	if (!result.ok || !result.data)
		throw new Error(result.error?.message ?? "Decision failed");
	return {
		recommendation: result.data.recommendation,
		allowedActionIds: result.data.allowedActionIds,
		traceId: result.data.traceId,
	};
}
