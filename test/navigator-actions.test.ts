import { describe, expect, it } from "vitest";
import { createNavigatorActions } from "@/lib/navigator/actions";
import {
	executeNavigatorAction,
	registerNavigatorAction,
	resetNavigatorActionsForTests,
} from "@/lib/navigator/registry";
import {
	contextFingerprint,
	NavigatorExecutionError,
} from "@/lib/navigator/types";

describe("Navigator semantic actions", () => {
	it("keeps UI hints separate and rejects stale targets before execution", async () => {
		resetNavigatorActionsForTests();
		const calls: string[] = [];
		const [open] = createNavigatorActions({
			openPaper: () => calls.push("open"),
			citePaper: () => undefined,
			translateSelection: async () => undefined,
			askAgentAboutSelection: async () => undefined,
			highlightSelection: async () => undefined,
		});
		registerNavigatorAction(open);
		const target = { kind: "paper" as const, vaultId: "v", paperId: "p" };
		const context = {
			target,
			capturedAt: new Date(0).toISOString(),
			resourceRevision: "1",
		};
		await expect(
			executeNavigatorAction("paper.open", target, context, () => null),
		).rejects.toMatchObject({ code: "stale-context" });
		await executeNavigatorAction("paper.open", target, context, () => ({
			target,
			resourceRevision: "1",
		}));
		expect(calls).toEqual(["open"]);
		expect(contextFingerprint(context)).toContain("paper:v:p");
	});

	it("does not let an action execute on an unsupported target", async () => {
		resetNavigatorActionsForTests();
		const [open] = createNavigatorActions({
			openPaper: async () => undefined,
			citePaper: async () => undefined,
			translateSelection: async () => undefined,
			askAgentAboutSelection: async () => undefined,
			highlightSelection: async () => undefined,
		});
		registerNavigatorAction(open);
		const selection = {
			kind: "selection" as const,
			panelId: "p",
			snapshotId: "s",
		};
		await expect(
			executeNavigatorAction("paper.open", selection, {
				target: selection,
				capturedAt: "now",
			}),
		).rejects.toBeInstanceOf(NavigatorExecutionError);
	});
});
