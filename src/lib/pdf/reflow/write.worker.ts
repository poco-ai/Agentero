import { errorText } from "@/lib/core/error";
import type { ReflowWriteTimings } from "./pdf-write";
import {
	executeWriteJob,
	type WriteFonts,
	type WriteRequest,
	type WriteResponse,
} from "./write-job";

const scope = self as unknown as {
	onmessage: (event: MessageEvent<WriteRequest>) => void;
	postMessage: (message: WriteResponse, transfer?: Transferable[]) => void;
};
let fonts: WriteFonts | undefined;

scope.onmessage = ({ data }) => {
	fonts = data.fonts ?? fonts;
	const timings: ReflowWriteTimings = {};
	void executeWriteJob(data.job, fonts, timings, (progress) =>
		scope.postMessage({ progress }),
	)
		.then((value) => {
			const bytes = Array.isArray(value)
				? null
				: value instanceof Uint8Array
					? value
					: value.bytes;
			scope.postMessage(
				{ value, timings },
				bytes?.buffer instanceof ArrayBuffer ? [bytes.buffer] : [],
			);
		})
		.catch((error: unknown) => scope.postMessage({ error: errorText(error) }));
};
