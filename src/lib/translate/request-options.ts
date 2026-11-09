/** Keep the validation contract in sync with Host apply_request_options. */
export function extraRequestBodyIssue(
	raw: string | undefined,
): "invalid" | "reserved" | null {
	if (!raw?.trim()) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return "invalid";
		if (
			["model", "messages", "stream"].some((key) => Object.hasOwn(value, key))
		)
			return "reserved";
		return null;
	} catch {
		return "invalid";
	}
}
