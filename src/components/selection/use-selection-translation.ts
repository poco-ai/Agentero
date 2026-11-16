import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AgentRunRefs, disposeAgentRun } from "@/lib/agent/run-attach";
import type { SelectionDraftScreen } from "@/lib/agent/selection-chat-store";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { runSelectionTranslate } from "@/lib/pdf/translate/run-selection";
import { loadSettings } from "@/lib/settings";
import {
	dictionarySurrounding,
	selectionTranslateMode,
} from "@/lib/translate/dictionary";
import type { SelectionTranslateMode } from "@/lib/translate/types";
import { getVaultPath } from "@/lib/vault/store";
import {
	claimSelectionTranslation,
	releaseSelectionTranslation,
} from "@/lib/workspace/selection-card-owner";

type Translation = {
	selection: SelectionContext;
	screen: SelectionDraftScreen;
	result: string;
	mode: SelectionTranslateMode;
	results: Partial<Record<SelectionTranslateMode, string>>;
	streaming: boolean;
	error: string | null;
};

/** Each request owns its refs, including while provider/Agent acceptance is pending. */
export function useSelectionTranslation() {
	const { t } = useTranslation("viewer");
	const [translation, setTranslation] = useState<Translation | null>(null);
	const translationRef = useRef(translation);
	translationRef.current = translation;
	const run = useRef<AgentRunRefs | null>(null);
	const close = useCallback(() => {
		releaseSelectionTranslation(close);
		if (run.current) disposeAgentRun(run.current);
		run.current = null;
		setTranslation(null);
	}, []);
	useEffect(() => close, [close]);
	const translate = useCallback(
		(
			selection: SelectionContext,
			screen: Translation["screen"],
			requestedMode?: SelectionTranslateMode,
		) => {
			const previous =
				translationRef.current?.selection.id === selection.id
					? translationRef.current
					: null;
			const results = { ...previous?.results };
			const mode =
				requestedMode ??
				selectionTranslateMode(
					selection.text,
					loadSettings().translate.dictionary.mode,
				);
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
				mode,
				results,
				result: results[mode] ?? "",
				streaming: !results[mode],
				error: null,
			});
			if (results[mode]) return;
			const current = () => run.current === refs && !refs.disposedRef.current;
			const patch = (update: (value: Translation) => Translation) => {
				if (current())
					setTranslation((value) => (value ? update(value) : value));
			};
			void runSelectionTranslate({
				text: selection.text,
				mode,
				context: {
					surface: `${selection.surface ?? selection.origin}-selection`,
					dictionarySurrounding: dictionarySurrounding(
						selection.text,
						selection.context,
					),
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
						results:
							event.stopReason === "cancelled"
								? value.results
								: {
										...value.results,
										[mode]: (event.content || value.result).trim(),
									},
					}));
					return current();
				},
				commitProviderResult: (result) =>
					patch((value) => ({
						...value,
						result,
						results: { ...value.results, [mode]: result },
						streaming: false,
					})),
				markFailed: (error) =>
					patch((value) => ({ ...value, error, streaming: false })),
				stopStreaming: () => patch((value) => ({ ...value, streaming: false })),
			});
		},
		[close, t],
	);
	const switchMode = useCallback(
		(mode: SelectionTranslateMode) => {
			const current = translationRef.current;
			if (current) translate(current.selection, current.screen, mode);
		},
		[translate],
	);
	return { translation, translate, switchMode, close };
}
