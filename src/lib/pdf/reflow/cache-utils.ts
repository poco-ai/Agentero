/** Shared hashing/compression/pathing helpers for reflow caches. */

const pdfDigests = new WeakMap<object, Promise<string>>();

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
	return Array.from(new Uint8Array(digest), (n) =>
		n.toString(16).padStart(2, "0"),
	).join("");
}

export function sha256Text(value: string): Promise<string> {
	return sha256Bytes(new TextEncoder().encode(value));
}

/** Content hash keyed by the viewer's byte buffer identity. */
export function pdfSha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	let pending = pdfDigests.get(bytes);
	if (!pending) {
		pending = sha256Bytes(
			bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
		).catch((error) => {
			pdfDigests.delete(bytes);
			throw error;
		});
		pdfDigests.set(bytes, pending);
	}
	return pending;
}

/** Filesystem-safe, readable paper folder segment plus a stable hash. */
export function paperSlug(paperKey: string): string {
	const base =
		paperKey.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "paper";
	const slug = base
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 48);
	return slug || "paper";
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === "undefined") return bytes;
	const stream = new Blob([bytes])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
	if (typeof DecompressionStream === "undefined")
		throw new Error("gzip decompression is unavailable");
	const stream = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
