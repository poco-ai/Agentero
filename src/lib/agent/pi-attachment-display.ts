export type PiAttachmentPart = {
	text: string;
	start: number;
	/** Present only for a standalone generated Pi scratch-file reference. */
	path?: string;
};

function attachmentPath(line: string): string | undefined {
	// Indented code, prose, inline code and ordinary @mentions stay untouched.
	const match = /^@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'`]+))[ \t]*$/.exec(
		line,
	);
	const path = match?.[1] ?? match?.[2] ?? match?.[3];
	if (!path || !/^(?:[a-z]:[\\/]|\/)/i.test(path)) return;
	const normalized = path.replaceAll("\\", "/");
	if (
		/\/\.pi-desktop\/scratch\/[^/]+\/pasted\/pasted-[^/]+\.txt$/.test(
			normalized,
		)
	)
		return path;
}

/** Display only: never change the stored prompt, copy payload or resend text. */
export function splitPiAttachmentReferences(text: string): PiAttachmentPart[] {
	const parts: PiAttachmentPart[] = [];
	let buffer = "";
	let start = 0;
	let fence: { marker: string; length: number } | undefined;
	for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const line = raw.replace(/\r?\n$/, "");
		const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (delimiter) {
			const marker = delimiter[1];
			if (!fence) fence = { marker: marker[0], length: marker.length };
			else if (
				marker[0] === fence.marker &&
				marker.length >= fence.length &&
				!delimiter[2].trim()
			)
				fence = undefined;
			buffer += raw;
			continue;
		}
		const path = fence ? undefined : attachmentPath(line);
		if (!path) {
			buffer += raw;
			continue;
		}
		if (buffer) {
			parts.push({ text: buffer, start });
			start += buffer.length;
		}
		parts.push({ text: raw, path, start });
		start += raw.length;
		buffer = "";
	}
	if (buffer) {
		parts.push({ text: buffer, start });
	}
	return parts;
}
