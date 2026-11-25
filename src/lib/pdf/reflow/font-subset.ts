import subsetWasmUrl from "harfbuzzjs/dist/harfbuzz-subset.wasm?url&inline";

type SubsetExports = {
	memory: WebAssembly.Memory;
	_initialize(): void;
	malloc(size: number): number;
	free(buffer: number): void;
	hb_blob_create(
		data: number,
		size: number,
		mode: number,
		userData: 0,
		destroy: 0,
	): number;
	hb_blob_destroy(blob: number): void;
	hb_blob_get_data(blob: number, length: 0): number;
	hb_blob_get_length(blob: number): number;
	hb_face_create(blob: number, index: 0): number;
	hb_face_destroy(face: number): void;
	hb_face_reference_blob(face: number): number;
	hb_set_add(set: number, codePoint: number): void;
	hb_subset_input_create_or_fail(): number;
	hb_subset_input_destroy(input: number): void;
	hb_subset_input_unicode_set(input: number): number;
	hb_subset_or_fail(face: number, input: number): number;
};

let engine: Promise<SubsetExports> | undefined;

async function loadSubsetter(): Promise<SubsetExports> {
	const bytes = await (await fetch(subsetWasmUrl)).arrayBuffer();
	const { instance } = await WebAssembly.instantiate(bytes);
	const hb = instance.exports as unknown as SubsetExports;
	hb._initialize();
	return hb;
}

export async function subsetReflowFont(
	bytes: Uint8Array,
	codePoints: ReadonlySet<number>,
): Promise<Uint8Array> {
	engine ??= loadSubsetter();
	const hb = await engine;
	const data = hb.malloc(bytes.length);
	if (!data) throw new Error("Could not allocate reflow font data");
	try {
		new Uint8Array(hb.memory.buffer, data, bytes.length).set(bytes);
		const readonlyMode = 1;
		const blob = hb.hb_blob_create(data, bytes.length, readonlyMode, 0, 0);
		const face = hb.hb_face_create(blob, 0);
		hb.hb_blob_destroy(blob);
		const input = hb.hb_subset_input_create_or_fail();
		try {
			if (!input) throw new Error("Could not create reflow font subset input");
			const unicodes = hb.hb_subset_input_unicode_set(input);
			for (const codePoint of codePoints) hb.hb_set_add(unicodes, codePoint);
			const subset = hb.hb_subset_or_fail(face, input);
			if (!subset) throw new Error("Could not subset reflow font");
			const result = hb.hb_face_reference_blob(subset);
			hb.hb_face_destroy(subset);
			try {
				return new Uint8Array(
					hb.memory.buffer,
					hb.hb_blob_get_data(result, 0),
					hb.hb_blob_get_length(result),
				).slice();
			} finally {
				hb.hb_blob_destroy(result);
			}
		} finally {
			if (input) hb.hb_subset_input_destroy(input);
			hb.hb_face_destroy(face);
		}
	} finally {
		hb.free(data);
	}
}
