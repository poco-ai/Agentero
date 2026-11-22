import { createStore } from "zustand/vanilla";
import type { Changelog, ChangelogRequest } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";
import bundledChangelog from "./changelog.json";

export const changelogStore = createStore<{
	data: Changelog;
	status: "idle" | "loading" | "ready" | "error";
}>(() => ({
	data: {
		...bundledChangelog,
		releases: bundledChangelog.releases.map((release) => ({
			...release,
			summary: "summary" in release ? (release.summary ?? null) : null,
		})),
	},
	status: isTauri() ? "idle" : "ready",
}));

let readCache: Promise<void> | undefined;
let refresh: Promise<ChangelogRequest> | undefined;

async function requestChangelog(request: ChangelogRequest) {
	const { commands } = await import("@/lib/core/bindings");
	const { callResult } = await import("@/lib/core/ipc");
	return callResult(() => commands.appChangelog(request));
}

function acceptChangelog(data: Changelog | null) {
	if (data) changelogStore.setState({ data });
}

export async function refreshChangelog(version?: string, force = false) {
	if (!isTauri()) return;
	readCache ??= requestChangelog("cached").then(
		acceptChangelog,
		() => undefined,
	);
	await readCache;
	const request =
		force || (version && !findChangelogRelease(version)) ? "force" : "refresh";
	if (refresh) {
		const completed = await refresh;
		if (
			request !== "force" ||
			completed === "force" ||
			(version && findChangelogRelease(version))
		)
			return;
	}
	if (refresh) return refresh;
	refresh = (async () => {
		changelogStore.setState({ status: "loading" });
		try {
			acceptChangelog(await requestChangelog(request));
			changelogStore.setState({ status: "ready" });
		} catch {
			changelogStore.setState({ status: "error" });
		} finally {
			refresh = undefined;
		}
		return request;
	})();
	await refresh;
}

function findChangelogRelease(version: string) {
	return changelogStore
		.getState()
		.data.releases.find(
			(release) => release.tag === `v${version}` && release.summary,
		);
}
