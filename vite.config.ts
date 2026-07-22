/// <reference types="vitest" />

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

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
		exclude: ["@embedpdf/pdfium", "@embedpdf/engines"],
	},

	test: {
		// Default to node; DOM-dependent suites opt in per-file with the
		// `// @vitest-environment jsdom` docblock (stores touching window/localStorage).
		environment: "node",
		include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
	},

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			// 3. tell Vite to ignore watching `src-tauri`
			ignored: ["**/src-tauri/**"],
		},
	},
}));
