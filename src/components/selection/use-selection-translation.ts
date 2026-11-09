import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AgentRunRefs, disposeAgentRun } from "@/lib/agent/run-attach";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { runSelectionTranslate } from "@/lib/pdf/translate/run-selection";
import { getVaultPath } from "@/lib/vault/store";
import {
	claimSelectionTranslation,
	releaseSelectionTranslation,
} from "@/lib/workspace/selection-card-owner";

type Translation = {
	selection: SelectionContext;
	screen: { x: number; y: number };
	result: string;
	streaming: boolean;
	error: string | null;
};

/** Each request owns its refs, including while provider/Agent acceptance is pending. */
export function useSelectionTranslation() {
	const { t } = useTranslation("viewer");
	const [translation, setTranslation] = useState<Translation | null>(null);
	const run = useRef<AgentRunRefs | null>(null);
	const close = useCallback(() => {
		releaseSelectionTranslation(close);
		if (run.current) disposeAgentRun(run.current);
		run.current = null;
		setTranslation(null);
	}, []);
	useEffect(() => close, [close]);
	const translate = useCallback(
		(selection: SelectionContext, screen: Translation["screen"]) => {
			close();
			claimSelectionTranslation(close);
			const refs: AgentRunRefs = {
				disposedRef: { current: false },
				unsubsRef: { current: null },
				sessionRef: { current: null },
				activeSessionRef: { current: null },
			};
			run.current = refs;
			setTranslation({
				selection,
				screen,
				result: "",
				streaming: true,
				error: null,
			});
			const current = () => run.current === refs && !refs.disposedRef.current;
			const patch = (update: (value: Translation) => Translation) => {
				if (current())
					setTranslation((value) => (value ? update(value) : value));
			};
			void runSelectionTranslate({
				text: selection.text,
				context: {
					surface: `${selection.surface ?? selection.origin}-selection`,
				},
				paperKey: selection.sourcePath,
				vaultPath: getVaultPath(),
				...refs,
				noAgentText: () => t("selection.translateNoAgent"),
				agentFailedText: () => t("pdfAsk.agentFailed"),
				appendChunk: (chunk) =>
					patch((value) => ({ ...value, result: value.result + chunk })),
				commitAgentResult: (event) => {
					patch((value) => ({
						...value,
						result: (event.content || value.result).trim(),
					}));
					return current();
				},
				commitProviderResult: (result) =>
					patch((value) => ({ ...value, result, streaming: false })),
				markFailed: (error) =>
					patch((value) => ({ ...value, error, streaming: false })),
				stopStreaming: () => patch((value) => ({ ...value, streaming: false })),
			});
		},
		[close, t],
	);
	return { translation, translate, close };
}
