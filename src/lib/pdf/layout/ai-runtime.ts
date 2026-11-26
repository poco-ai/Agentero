import {
	type AiPipeline,
	type AiRuntime,
	type LayoutDetectionInput,
	LayoutDetectionPipeline,
} from "@embedpdf/ai";
import { createAiRuntime } from "@embedpdf/ai/web";

import { isTauri, isWindows } from "@/lib/core/tauri";
import { createLayoutInferenceClient } from "@/lib/pdf/layout/inference-client";
import { layoutModelLocalUrl } from "@/lib/pdf/layout/model";

/**
 * Shared browser AI runtime for EmbedPDF layout analysis.
 * Created once: loads ONNX Runtime on demand.
 *
 * In Tauri, the ONNX file lives under XDG cache
 * (`$XDG_CACHE_HOME/agentero/models/pp-doclayoutv3.onnx`), prefetched at
 * app startup (ModelScope first, HuggingFace fallback) and served via the
 * `agentero-model` custom protocol. Browser Cache API is disabled so we do
 * not double-cache the Host-managed file.
 */
let runtime: AiRuntime | null = null;

export function getPdfAiRuntime(): AiRuntime {
	if (!runtime) {
		const desktop = isTauri();
		const modelUrl = desktop ? layoutModelLocalUrl() : undefined;
		const models = modelUrl
			? {
					"layout-detection": {
						url: modelUrl,
					},
				}
			: undefined;
		const shared = createAiRuntime({
			backend: "auto",
			// Disk-managed in Tauri; keep Cache API only for plain browser.
			cache: !desktop,
			models,
		});
		const inference =
			modelUrl && typeof Worker !== "undefined" && isWindows()
				? createLayoutInferenceClient(modelUrl, (input) =>
						shared.run(new LayoutDetectionPipeline(), input),
					)
				: undefined;
		// Viewer unmount and the headless registry both call `runtime.destroy()`,
		// which releases the ONNX session. A second in-flight layout job then
		// fails with "cannot run inference. invalid session id". The Windows
		// layout worker retires on inference idle, independent of plugin lifetime.
		runtime = new Proxy(shared, {
			get(target, prop, receiver) {
				if (prop === "destroy") return () => Promise.resolve();
				if (inference && prop === "run") {
					return (pipeline: AiPipeline<unknown, unknown>, input: unknown) =>
						pipeline instanceof LayoutDetectionPipeline &&
						!target.isModelLoaded(pipeline.modelId)
							? inference.run(input as LayoutDetectionInput)
							: target.run(pipeline, input);
				}
				if (inference && prop === "isModelLoaded") {
					return (modelId: string) =>
						(modelId === "layout-detection" && inference.isLoaded()) ||
						target.isModelLoaded(modelId);
				}
				if (inference && prop === "getBackend") {
					return () => (inference.isLoaded() ? "wasm" : target.getBackend());
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as AiRuntime;
	}
	return runtime;
}
