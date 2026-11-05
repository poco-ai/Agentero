import { describe, expect, it } from "vitest";

import { parseLookupDiagnostic } from "@/lib/paper/lookup-diagnostics";

describe("web import translator diagnostics", () => {
	it("reads a 503/1102 degradation for a page that still imported", () => {
		expect(
			parseLookupDiagnostic(
				"translator_degraded|503|1102|page|https://translation-server.agentero.app",
			),
		).toEqual({
			kind: "degraded",
			status: "503",
			code: "1102",
			mode: "page",
			host: "https://translation-server.agentero.app",
		});
	});

	it("reads a URL-only degradation when the page itself could not be fetched", () => {
		expect(
			parseLookupDiagnostic(
				"translator_degraded|503|1102|url_only|https://translation-server.agentero.app",
			),
		).toMatchObject({ kind: "degraded", mode: "url_only", code: "1102" });
	});

	it("reads an unavailable error that is not a web page and has no identifier", () => {
		const parsed = parseLookupDiagnostic(
			"notes: translator_unavailable|503|1102|https://translation-server.agentero.app translation service unavailable (HTTP 503, error code: 1102); input is not a web page and no DOI, arXiv ID, or PMID matched",
		);
		expect(parsed).toEqual({
			kind: "unavailable",
			status: "503",
			code: "1102",
			host: "https://translation-server.agentero.app",
		});
	});

	it("leaves ordinary import errors untouched", () => {
		expect(parseLookupDiagnostic("asset download error: timeout")).toBeNull();
	});
});
