import type {
	AiErrorReason,
	LayoutDetection,
	LayoutDetectionInput,
	PipelineProgress,
} from "@embedpdf/ai";
import { Task, TaskStage } from "@embedpdf/models";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import type {
	LayoutInferenceRequest,
	LayoutInferenceResponse,
} from "./inference.worker";

const IDLE_MS = 60_000;
type InferenceTask = Task<LayoutDetection[], AiErrorReason, PipelineProgress>;

export function createLayoutInferenceClient(
	modelUrl: string,
	runInline: (
		input: LayoutDetectionInput,
	) => Pick<InferenceTask, "onProgress" | "wait">,
) {
	let worker: Worker | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let nextId = 0;
	let activeId: number | undefined;
	let loaded = false;
	let workerAvailable = true;
	const pending = new Map<
		number,
		{ task: InferenceTask; input: LayoutDetectionInput }
	>();

	function stop() {
		clearTimeout(idleTimer);
		worker?.terminate();
		worker = undefined;
		activeId = undefined;
		loaded = false;
	}

	function startInline(task: InferenceTask, input: LayoutDetectionInput) {
		if (task.state.stage !== TaskStage.Pending) return;
		const inline = runInline(input);
		inline.onProgress((progress) => task.progress(progress));
		inline.wait(
			(detections) => task.resolve(detections),
			(error) => task.fail(error),
		);
	}

	function fallBackToInline(message: string) {
		workerAvailable = false;
		stop();
		logger.warn("PDF layout inference worker unavailable", { error: message });
		for (const { task, input } of pending.values()) {
			startInline(task, input);
		}
		pending.clear();
	}

	function start(): Worker {
		const target = new Worker(
			new URL("./inference.worker.ts", import.meta.url),
			{
				type: "module",
			},
		);
		target.onmessage = ({ data }: MessageEvent<LayoutInferenceResponse>) => {
			if (worker !== target) return;
			const job = pending.get(data.id);
			if (!job) return;
			const { task } = job;
			if ("progress" in data) {
				task.progress(data.progress);
				return;
			}
			if (
				!loaded &&
				"error" in data &&
				data.error.type === "model-load-failed"
			) {
				fallBackToInline(data.error.message);
				return;
			}
			pending.delete(data.id);
			activeId = undefined;
			if ("error" in data) task.reject(data.error);
			else {
				loaded = true;
				task.resolve(data.detections);
			}
			pump();
		};
		target.onerror = (event) => {
			if (worker === target)
				fallBackToInline(event.message || "PDF layout worker failed");
		};
		target.onmessageerror = () => {
			if (worker === target)
				fallBackToInline("Could not read PDF layout worker response");
		};
		return target;
	}

	function pump() {
		// Run one page at a time so parallel document jobs share the model
		// without overlapping image preprocessing and WASM allocations.
		if (activeId !== undefined) return;
		for (const [id, { task, input }] of pending) {
			if (task.state.stage !== TaskStage.Pending) {
				pending.delete(id);
				continue;
			}
			activeId = id;
			try {
				worker ??= start();
				const request: LayoutInferenceRequest = { id, modelUrl, input };
				worker.postMessage(request);
			} catch (error) {
				fallBackToInline(errorText(error));
			}
			return;
		}
		// An aborted caller's active request reaches here only when the
		// native inference has actually returned.
		if (worker) idleTimer = setTimeout(stop, IDLE_MS);
	}

	return {
		isLoaded: () => loaded,
		run(input: LayoutDetectionInput): InferenceTask {
			const task = new Task<
				LayoutDetection[],
				AiErrorReason,
				PipelineProgress
			>();
			if (!workerAvailable) {
				startInline(task, input);
				return task;
			}
			clearTimeout(idleTimer);
			const id = ++nextId;
			pending.set(id, { task, input });
			pump();
			return task;
		},
	};
}
