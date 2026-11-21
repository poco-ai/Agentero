import { expect, it } from "vitest";
import { pickPdfSearchDocumentId } from "@/lib/pdf/search-target";

const ids = {
	sourceDocumentId: "source",
	translatedDocumentId: "translated",
};

it("searches the translated PDF only while its text is visible", () => {
	expect(pickPdfSearchDocumentId({ ...ids, translationVisible: true })).toBe(
		"translated",
	);
	expect(pickPdfSearchDocumentId({ ...ids, translationVisible: false })).toBe(
		"source",
	);
});

it("keeps searching the source until the translated PDF is ready", () => {
	expect(
		pickPdfSearchDocumentId({
			sourceDocumentId: "source",
			translationVisible: true,
		}),
	).toBe("source");
});
