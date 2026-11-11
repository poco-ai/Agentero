/** Numbered main captions, including Nature's separator and Extended Data. */
export function figureCaptionKey(text: string): string | null {
	const chinese = text.trim().match(/^[图圖]\s*(\d+)\s*(?:[.:：]|\s)\s*\S/u);
	if (chinese) return `figure-${chinese[1]}`;
	const match = text
		.trim()
		.match(/^(extended\s+data\s+)?fig(?:ure)?\.?\s*(\d+)\s*[:.|]\s+\S/i);
	return match ? `${match[1] ? "extended-" : ""}figure-${match[2]}` : null;
}
