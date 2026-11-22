import { lazy, Suspense } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ChangelogView } from "@/lib/update/types";

const viewStore = createStore<ChangelogView | null>(() => null);
const ChangelogDialog = lazy(() => import("./changelog-dialog"));
let opener: HTMLElement | null = null;

export function openChangelog(view: ChangelogView) {
	opener =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	viewStore.setState(view, true);
}

export function ChangelogHost() {
	const view = useStore(viewStore);
	if (!view) return null;
	return (
		<Suspense fallback={null}>
			<ChangelogDialog
				view={view}
				onClose={() => viewStore.setState(null, true)}
				onCloseAutoFocus={() => {
					if (opener?.isConnected) opener.focus();
				}}
			/>
		</Suspense>
	);
}
