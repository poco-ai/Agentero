/** Pick the PDF whose text layer matches what the reader currently sees. */
export function pickPdfSearchDocumentId({
	sourceDocumentId,
	translatedDocumentId,
	translationVisible,
}: {
	sourceDocumentId: string;
	translatedDocumentId?: string | null;
	translationVisible: boolean;
}): string {
	return translationVisible && translatedDocumentId
		? translatedDocumentId
		: sourceDocumentId;
}
