import {
	type AiErrorReason,
	type LayoutDetection,
	type LayoutDetectionInput,
	LayoutDetectionPipeline,
	type PipelineProgress,
} from "@embedpdf/ai";
import { createAiRuntime } from "@embedpdf/ai/web";

export type LayoutInferenceRequest = {
	id: number;
	modelUrl: string;
	input: LayoutDetectionInput;
};

export type LayoutInferenceResponse = { id: number } & (
	| { progress: PipelineProgress }
	| { detections: LayoutDetection[] }
	| { error: AiErrorReason }
);

const scope = self as unknown as {
	onmessage: (event: MessageEvent<LayoutInferenceRequest>) => void;
	postMessage: (response: LayoutInferenceResponse) => void;
};
const pipeline = new LayoutDetectionPipeline();
let runtime: ReturnType<typeof createAiRuntime> | undefined;

scope.onmessage = ({ data: { id, modelUrl, input } }) => {
	runtime ??= createAiRuntime({
		backend: "wasm",
		cache: false,
		models: { [pipeline.modelId]: { url: modelUrl } },
	});
	const task = runtime.run(pipeline, input);
	task.onProgress((progress) => scope.postMessage({ id, progress }));
	task.wait(
		(detections) => scope.postMessage({ id, detections }),
		({ reason }) => scope.postMessage({ id, error: reason }),
	);
};
