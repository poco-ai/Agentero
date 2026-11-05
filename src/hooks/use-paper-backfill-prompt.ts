/**
 * Render the vault backfill prompt toast in the main window.
 *
 * `lib/paper/backfill` decides when the prompt appears but must stay
 * component-free (`lib-no-components`), so it exposes a presenter slot
 * (same pattern as `setNetworkFailureReporter` in `lib/core/notify`);
 * this hook installs the React rendering side at App mount.
 */

import { createElement, useEffect } from "react";
import { toast } from "sonner";
import { BackfillPrompt } from "@/components/paper/backfill-prompt";
import { setBackfillPromptPresenter } from "@/lib/paper/backfill";

/** New key per prompt so a reused toast id starts with fresh review state. */
let promptSequence = 0;

export function usePaperBackfillPrompt(): void {
	useEffect(() => {
		setBackfillPromptPresenter(({ preview, toastId, onLater, onStart }) => {
			toast.custom(
				() =>
					createElement(BackfillPrompt, {
						key: ++promptSequence,
						preview,
						onLater,
						onStart,
					}),
				{
					id: toastId,
					duration: Number.POSITIVE_INFINITY,
					dismissible: false,
					style: { width: "min(26rem, calc(100vw - 1.5rem))" },
				},
			);
		});
		return () => setBackfillPromptPresenter(null);
	}, []);
}
