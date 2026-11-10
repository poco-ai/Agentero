import { lifecycle } from "@/lib/lifecycle";
import { suggestionCoordinator } from "./suggestions";

export function registerSuggestionLifecycle(): () => void {
	const offAssets = lifecycle.on("paper:assets-ready", (payload) => {
		suggestionCoordinator.onAssetsReady(payload);
	});
	const offJobs = lifecycle.on("job:completed", (payload) => {
		suggestionCoordinator.onJobCompleted(payload);
	});
	return () => {
		offAssets();
		offJobs();
	};
}
