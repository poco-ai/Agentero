/** Lightweight identity for a PDF output; safe to pass through React props. */
export type ReflowOutputVersion = Readonly<{ id: number }>;

const versions = new WeakMap<Uint8Array, ReflowOutputVersion>();
let sequence = 0;

export function reflowOutputVersion(bytes: Uint8Array): ReflowOutputVersion {
	let version = versions.get(bytes);
	if (!version) {
		version = Object.freeze({ id: ++sequence });
		versions.set(bytes, version);
	}
	return version;
}
