import type { AiPipeline } from "@embedpdf/ai";
import { createAiRuntime } from "@embedpdf/ai/web";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeSpies = vi.hoisted(() => ({
	wasmCreate: vi.fn(),
	webgpuCreate: vi.fn(),
}));

vi.mock("onnxruntime-web/wasm", () => {
	class Tensor {
		constructor(
			readonly type: string,
			readonly data: Float32Array,
			readonly dims: readonly number[],
		) {}

		dispose(): void {}
	}

	return {
		env: { wasm: {} },
		Tensor,
		InferenceSession: {
			create: (...args: unknown[]) => runtimeSpies.wasmCreate(...args),
		},
	};
});

vi.mock("onnxruntime-web/webgpu", () => {
	class Tensor {
		constructor(
			readonly type: string,
			readonly data: Float32Array,
			readonly dims: readonly number[],
		) {}

		dispose(): void {}
	}

	return {
		env: { wasm: {} },
		Tensor,
		InferenceSession: {
			create: (...args: unknown[]) => runtimeSpies.webgpuCreate(...args),
		},
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("EmbedPDF AI backend routing", () => {
	it.each([
		["wasm", runtimeSpies.wasmCreate, runtimeSpies.webgpuCreate],
		["cpu", runtimeSpies.wasmCreate, runtimeSpies.webgpuCreate],
		["webgpu", runtimeSpies.webgpuCreate, runtimeSpies.wasmCreate],
	] as const)("loads the matching runtime for the %s backend", async (backend, expectedCreate, unexpectedCreate) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([0]))),
		);
		runtimeSpies.wasmCreate.mockResolvedValue(createSession());
		runtimeSpies.webgpuCreate.mockResolvedValue(createSession());

		const runtime = createAiRuntime({
			backend,
			cache: false,
			models: {
				"backend-routing-test": { url: "https://example.test/model.onnx" },
			},
		});

		await expect(
			runtime.run(createPipeline(), undefined).toPromise(),
		).resolves.toBe(7);
		expect(expectedCreate).toHaveBeenCalledOnce();
		expect(unexpectedCreate).not.toHaveBeenCalled();
		await runtime.destroy();
	});
});

function createSession() {
	return {
		inputNames: ["input"],
		outputNames: ["output"],
		run: vi.fn(async () => ({
			output: {
				type: "float32",
				data: new Float32Array([7]),
				dims: [1],
				dispose: vi.fn(),
			},
		})),
		release: vi.fn(async () => undefined),
	};
}

function createPipeline(): AiPipeline<void, number> {
	return {
		modelId: "backend-routing-test",
		preprocess: () => ({
			input: {
				type: "float32",
				data: new Float32Array([1]),
				dims: [1],
			},
		}),
		postprocess: (outputs) => Number(outputs.output.data[0]),
	};
}
