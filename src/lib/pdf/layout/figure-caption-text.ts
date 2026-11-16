/** Numbered main captions, including Nature's separator and Extended Data. */
export function figureCaptionKey(text: string): string | null {
	const match = text
		.trim()
		.match(/^(extended\s+data\s+)?fig(?:ure)?\.?\s*(\d+)([\s\S]*)/i);
	if (!match) return null;
	// Publishers also omit the separator; OCR can join the number and the first
	// word. Require a capitalized word in that case, not a subpanel suffix (3a).
	const tail = match[3];
	if (!/^(?:\s*[:.|]\s*\S|\s+[A-Z][a-z]|[A-Z][a-z]{2})/.test(tail)) return null;
	return `${match[1] ? "extended-" : ""}figure-${match[2]}`;
}
