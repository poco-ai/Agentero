/// <reference types="vitest" />

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const port = Number(process.env.TAURI_DEV_PORT) || 1420;

// https://vite.dev/config/
export default defineConfig(async () => ({
	plugins: [react(), tailwindcss()],

	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},

	// EmbedPDF ships a PDFium WASM binary + web worker. Emit the wasm as an
	// asset, bundle the worker as an ES module, and keep Vite from pre-bundling
	// these packages (dep-optimize rewrites break their wasm/worker loading).
	assetsInclude: ["**/*.wasm"],
	worker: {
		format: "es",
	},
	optimizeDeps: {
		// PDFium + ONNX Runtime load wasm/workers; dep-optimize rewrites break them.
		exclude: [
			"@embedpdf/pdfium",
			"@embedpdf/engines",
			"onnxruntime-web",
			"@embedpdf/ai",
		],
	},

	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		server: {
			deps: {
				inline: [/@embedpdf\/ai/],
			},
		},
	},

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port,
		strictPort: true,
		// iOS Simulator reaches the Mac dev server through the local network
		// bridge; binding only to loopback makes localhost:1420 unreachable.
		host: host || "0.0.0.0",
		hmr: host
			? {
					protocol: "ws",
					host,
					port: port + 1,
				}
			: undefined,
		watch: {
			// 3. tell Vite to ignore watching `src-tauri`
			ignored: ["**/src-tauri/**"],
		},
	},
}));
