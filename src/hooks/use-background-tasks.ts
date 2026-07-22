import { backgroundTasksStore } from "@/stores/background-tasks-store";

/** Live background-task list + panel expansion, from the Zustand store. */
export function useBackgroundTasks() {
	return backgroundTasksStore.use((s) => s);
}
