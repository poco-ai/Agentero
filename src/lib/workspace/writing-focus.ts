import { writingHistoryProjectRel } from "@/lib/writing/session";
import type { DocTab } from "./tabs";

export function isWritingSource(
	tab: DocTab | undefined,
	vault: string | null,
): boolean {
	return Boolean(
		vault && tab?.writingRoot && writingHistoryProjectRel(vault, tab.path),
	);
}
