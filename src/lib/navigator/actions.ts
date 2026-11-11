import type { NavigatorAction, SemanticTarget } from "./types";

export type NavigatorHandlers = {
	openPaper: (
		target: Extract<SemanticTarget, { kind: "paper" }>,
	) => Promise<unknown> | unknown;
	citePaper: (
		target: Extract<SemanticTarget, { kind: "paper" }>,
	) => Promise<unknown> | unknown;
	translateSelection: (
		target: Extract<SemanticTarget, { kind: "selection" }>,
	) => Promise<unknown>;
	askAgentAboutSelection: (
		target: Extract<SemanticTarget, { kind: "selection" }>,
	) => Promise<unknown>;
	highlightSelection: (
		target: Extract<SemanticTarget, { kind: "selection" }>,
	) => Promise<unknown>;
};

const paper = (
	target: SemanticTarget,
): target is Extract<SemanticTarget, { kind: "paper" }> =>
	target.kind === "paper";
const selection = (
	target: SemanticTarget,
): target is Extract<SemanticTarget, { kind: "selection" }> =>
	target.kind === "selection";

export function createNavigatorActions(
	handlers: NavigatorHandlers,
): NavigatorAction[] {
	const paperHandler =
		(
			handler: NavigatorHandlers["openPaper"] | NavigatorHandlers["citePaper"],
		) =>
		(target: SemanticTarget) => {
			if (!paper(target))
				return Promise.reject(new Error("paper target required"));
			return Promise.resolve(handler(target));
		};
	const selectionHandler =
		(
			handler:
				| NavigatorHandlers["translateSelection"]
				| NavigatorHandlers["askAgentAboutSelection"]
				| NavigatorHandlers["highlightSelection"],
		) =>
		(target: SemanticTarget) => {
			if (!selection(target))
				return Promise.reject(new Error("selection target required"));
			return handler(target);
		};
	return [
		{
			id: "paper.open",
			supports: paper,
			isAvailable: (target) => paper(target) && Boolean(target.paperId),
			effects: ["read"],
			confirmation: "never",
			execute: paperHandler(handlers.openPaper),
		},
		{
			id: "paper.cite",
			supports: paper,
			isAvailable: (target) => paper(target) && Boolean(target.paperId),
			effects: ["read"],
			confirmation: "never",
			execute: paperHandler(handlers.citePaper),
		},
		{
			id: "pdf.selection.translate",
			supports: selection,
			isAvailable: (target) => selection(target) && Boolean(target.snapshotId),
			effects: ["read", "network"],
			confirmation: "on-suggestion",
			execute: selectionHandler(handlers.translateSelection),
		},
		{
			id: "pdf.selection.ask-agent",
			supports: selection,
			isAvailable: (target) => selection(target) && Boolean(target.snapshotId),
			effects: ["read", "network"],
			confirmation: "on-suggestion",
			execute: selectionHandler(handlers.askAgentAboutSelection),
		},
		{
			id: "pdf.selection.highlight",
			supports: selection,
			isAvailable: (target) => selection(target) && Boolean(target.snapshotId),
			effects: ["write"],
			confirmation: "never",
			execute: selectionHandler(handlers.highlightSelection),
		},
	];
}
