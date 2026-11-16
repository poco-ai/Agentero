import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import { z } from "zod";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		gt: { type: "string" },
		out: { type: "string" },
		manifest: { type: "string" },
		images: { type: "string" },
		model: { type: "string" },
		snapshot: { type: "string" },
		ocr: { type: "string" },
		"document-map": { type: "string" },
		seed: { type: "string", default: "agentero-bbox-v1" },
		limit: { type: "string", default: "20" },
		split: { type: "string", default: "dev" },
		revision: { type: "string", default: "aa1ee96" },
	},
});
const command = positionals[0];
if (
	!["prepare", "download", "capture", "enrich", "evaluate"].includes(command)
) {
	console.log(
		"node scripts/omnidocbench-bbox/run.mjs prepare --gt OmniDocBench.json --out manifest.json [--limit 20] [--document-map papers.json]\n  download --manifest manifest.json --images tmp/images\n  capture --manifest manifest.json --images tmp/images --model pp-doclayoutv3.onnx --out snapshot.json\n  enrich --manifest manifest.json --snapshot snapshot.json --ocr ocr.json --out snapshot-ocr.json\n  evaluate --manifest manifest.json --snapshot snapshot.json --out tmp/report [--split dev|test]",
	);
	process.exit(1);
}
function required(name) {
	if (!values[name]) throw new Error(`Missing --${name}`);
	return values[name];
}
const load = async (name) =>
	JSON.parse(await readFile(path.resolve(required(name)), "utf8"));
const save = async (file, value, exclusive = false) => {
	await mkdir(path.dirname(path.resolve(file)), { recursive: true });
	await writeFile(file, JSON.stringify(value, null, 2), {
		flag: exclusive ? "wx" : "w",
	});
};
function inside(dir, name) {
	const base = path.resolve(dir),
		full = path.resolve(base, name);
	if (full === base || !full.startsWith(`${base}${path.sep}`))
		throw new Error(`Unsafe image path: ${name}`);
	return full;
}
const server = await createServer({
	configFile: false,
	root,
	optimizeDeps: { noDiscovery: true, include: [] },
	server: { middlewareMode: true, watch: null, hmr: false },
	resolve: { alias: { "@": path.join(root, "src") } },
	appType: "custom",
});
try {
	const core = await server.ssrLoadModule("/scripts/omnidocbench-bbox/core.ts");
	const pipeline = await server.ssrLoadModule(
		"/scripts/omnidocbench-bbox/pipeline.ts",
	);
	const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	if (command === "prepare") {
		const bytes = await readFile(required("gt"));
		const limit = Number(values.limit);
		if (!Number.isInteger(limit) || limit < 1)
			throw new Error("--limit must be a positive integer");
		const parsed = core.datasetSchema.safeParse(
			JSON.parse(bytes.toString("utf8")),
		);
		if (!parsed.success)
			throw new Error(
				`Unsupported dataset schema: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`,
			);
		const pages = parsed.data;
		const documentMap = values["document-map"]
			? await load("document-map")
			: {};
		const manifest = core.makeManifest(
			pages,
			core.sha256(bytes),
			`https://huggingface.co/datasets/opendatalab/OmniDocBench/tree/${values.revision}`,
			values.seed,
			documentMap,
			limit,
		);
		if (!manifest.cases.length) throw new Error("No eligible academic pages");
		await save(required("out"), manifest);
		console.log(
			JSON.stringify({
				pages: manifest.cases.length,
				targets: manifest.cases.reduce((n, p) => n + p.targets.length, 0),
				dev: manifest.cases.filter((p) => p.split === "dev").length,
				test: manifest.cases.filter((p) => p.split === "test").length,
				unknownDocuments: manifest.cases.filter((p) => !p.documentId).length,
				excludedPages: manifest.exclusions.length,
			}),
		);
	} else if (command === "download") {
		const manifest = await load("manifest");
		if (!/^[a-f0-9]{7,40}$/i.test(values.revision))
			throw new Error("Use an immutable dataset commit for --revision");
		for (const p of manifest.cases) {
			const output = inside(required("images"), p.imagePath);
			const url = `https://huggingface.co/datasets/opendatalab/OmniDocBench/resolve/${values.revision}/images/${p.imagePath.split("/").map(encodeURIComponent).join("/")}`;
			await mkdir(path.dirname(output), { recursive: true });
			if (process.platform === "win32") {
				execFileSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						"$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri $env:AGENTERO_BBOX_DOWNLOAD_URL -OutFile $env:AGENTERO_BBOX_DOWNLOAD_PATH -TimeoutSec 60",
					],
					{
						windowsHide: true,
						stdio: "pipe",
						timeout: 70_000,
						env: {
							...process.env,
							AGENTERO_BBOX_DOWNLOAD_URL: url,
							AGENTERO_BBOX_DOWNLOAD_PATH: output,
						},
					},
				);
			} else {
				const response = await fetch(url, {
					signal: AbortSignal.timeout(60_000),
				});
				if (!response.ok) throw new Error(`${response.status}: ${url}`);
				const bytes = Buffer.from(await response.arrayBuffer());
				if (bytes.length > 32 * 1024 * 1024)
					throw new Error("Image exceeds 32 MiB");
				await writeFile(output, bytes);
			}
			console.log(`Downloaded ${p.imagePath}`);
		}
	} else if (command === "capture") {
		const manifestBytes = await readFile(required("manifest"));
		const manifest = JSON.parse(manifestBytes.toString("utf8"));
		const { LayoutDetectionPipeline } = await import("@embedpdf/ai");
		const ort = await import("onnxruntime-web");
		const { PdfiumNative } = await import("@embedpdf/engines/pdfium");
		const { init } = await import("@embedpdf/pdfium");
		const { PDFDocument } = await import("pdf-lib");
		const { pageLayoutToRegions } = await server.ssrLoadModule(
			"/src/lib/pdf/layout/normalize.ts",
		);
		const model = await readFile(required("model"));
		ort.env.wasm.numThreads = 1;
		const session = await ort.InferenceSession.create(model, {
			executionProviders: ["wasm"],
		});
		const adapter = {
			inputNames: [...session.inputNames],
			outputNames: [...session.outputNames],
			run: async (feeds) =>
				session.run(
					Object.fromEntries(
						Object.entries(feeds).map(([key, value]) => [
							key,
							new ort.Tensor(value.type, value.data, value.dims),
						]),
					),
				),
		};
		const detector = new LayoutDetectionPipeline();
		const { NoopLogger } = await import("@embedpdf/models");
		const context = { backend: "wasm", logger: new NoopLogger() };
		const pdf = new PdfiumNative(
			await init({
				wasmBinary: await readFile(
					fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
				),
			}),
			{ fontFallback: null },
		);
		const pages = [];
		try {
			for (const record of manifest.cases) {
				const bytes = await readFile(
					inside(required("images"), record.imagePath),
				);
				const container = await PDFDocument.create();
				const embedded =
					bytes[0] === 137
						? await container.embedPng(bytes)
						: await container.embedJpg(bytes);
				if (
					embedded.width !== record.width ||
					embedded.height !== record.height
				)
					throw new Error(`Image/GT dimension mismatch: ${record.imagePath}`);
				container
					.addPage([embedded.width, embedded.height])
					.drawImage(embedded, {
						x: 0,
						y: 0,
						width: embedded.width,
						height: embedded.height,
					});
				const document = await pdf
					.openDocumentBuffer({
						id: record.imagePath,
						content: (await container.save()).buffer,
					})
					.toPromise();
				try {
					const image = await pdf
						.renderPageRaw(document, document.pages[0], { scaleFactor: 1 })
						.toPromise();
					const feeds = detector.preprocess(
						{
							imageData: image,
							sourceWidth: image.width,
							sourceHeight: image.height,
						},
						adapter,
						context,
					);
					const detections = detector.postprocess(
						await adapter.run(feeds),
						context,
					);
					const regions = pageLayoutToRegions({
						pageIndex: 0,
						pageSize: { width: record.width, height: record.height },
						blocks: detections.map((d) => ({
							id: String(d.id),
							label: d.label,
							score: d.score,
							readingOrder: d.readingOrder,
							rect: {
								origin: { x: d.bbox[0], y: d.bbox[1] },
								size: {
									width: d.bbox[2] - d.bbox[0],
									height: d.bbox[3] - d.bbox[1],
								},
							},
						})),
					});
					pages.push({
						imagePath: record.imagePath,
						imageSha256: core.sha256(bytes),
						blocks: pipeline.normalizeLayoutRegions(regions),
					});
					console.log(`${record.imagePath}: ${regions.length} detections`);
				} finally {
					await pdf.closeDocument(document).toPromise();
				}
			}
		} finally {
			await session.release();
			await pdf.destroy().toPromise();
		}
		await save(
			required("out"),
			{
				schemaVersion: 1,
				manifestSha256: core.sha256(manifestBytes),
				modelSha256: core.sha256(model),
				gitHead,
				inputMode: "detector-only-no-text",
				pages,
			},
			true,
		);
	} else if (command === "enrich") {
		const manifestBytes = await readFile(required("manifest"));
		const manifest = JSON.parse(manifestBytes.toString("utf8"));
		const snapshotBytes = await readFile(required("snapshot"));
		const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
		const ocrBytes = await readFile(required("ocr")),
			ocr = JSON.parse(ocrBytes.toString("utf8"));
		const lineSchema = z.object({
			poly: z
				.array(z.tuple([z.number().finite(), z.number().finite()]))
				.length(4),
			text: z.string(),
			score: z.number().min(0).max(1),
		});
		if (
			ocr.schemaVersion !== 1 ||
			typeof ocr.engine !== "string" ||
			typeof ocr.engineVersion !== "string" ||
			ocr.pages.length !== manifest.cases.length ||
			snapshot.pages.length !== manifest.cases.length
		)
			throw new Error("Invalid OCR schema or page count");
		if (
			snapshot.inputMode !== "detector-only-no-text" ||
			snapshot.manifestSha256 !== core.sha256(manifestBytes) ||
			ocr.manifestSha256 !== snapshot.manifestSha256
		)
			throw new Error(
				"OCR, raw snapshot and manifest must describe the same dataset",
			);
		const { enrichCaptionRegionsWithText } = await server.ssrLoadModule(
			"/src/lib/pdf/layout/title-text.ts",
		);
		const pages = manifest.cases.map((record) => {
			const inputs = snapshot.pages.filter(
				(p) => p.imagePath === record.imagePath,
			);
			const texts = ocr.pages.filter((p) => p.imagePath === record.imagePath);
			if (
				inputs.length !== 1 ||
				texts.length !== 1 ||
				texts[0].imageSha256 !== inputs[0].imageSha256
			)
				throw new Error(
					`OCR page missing, duplicated or from another image: ${record.imagePath}`,
				);
			const runs = z
				.array(lineSchema)
				.parse(texts[0].lines)
				.filter((line) => line.score >= 0.5)
				.map((line) => {
					const xs = line.poly.map((p) => p[0]),
						ys = line.poly.map((p) => p[1]);
					const x = Math.min(...xs),
						y = Math.min(...ys),
						width = Math.max(...xs) - x,
						height = Math.max(...ys) - y;
					if (
						x < 0 ||
						y < 0 ||
						width <= 0 ||
						height <= 0 ||
						x + width > record.width + 1 ||
						y + height > record.height + 1
					)
						throw new Error("OCR line outside image");
					return {
						text: line.text,
						rect: { origin: { x, y }, size: { width, height } },
					};
				});
			const regions = pipeline
				.layoutRegionsFromBlocks(inputs[0].blocks)
				.map((r) => ({
					...r,
					rect: {
						x: r.bbox.x * record.width,
						y: r.bbox.y * record.height,
						w: r.bbox.w * record.width,
						h: r.bbox.h * record.height,
					},
				}));
			const enriched = enrichCaptionRegionsWithText(regions, 0, runs, {
				width: record.width,
				height: record.height,
			});
			return {
				...inputs[0],
				blocks: pipeline.normalizeLayoutRegions(enriched),
			};
		});
		await save(
			required("out"),
			{
				...snapshot,
				gitHead,
				inputMode: "detector-plus-ocr",
				parentSnapshotSha256: core.sha256(snapshotBytes),
				ocrSha256: core.sha256(ocrBytes),
				ocrEngine: ocr.engine,
				ocrEngineVersion: ocr.engineVersion,
				pages,
			},
			true,
		);
		console.log(`Enriched ${pages.length} pages from observed OCR lines`);
	} else {
		const manifestBytes = await readFile(required("manifest")),
			manifest = JSON.parse(manifestBytes.toString("utf8"));
		const snapshotBytes = await readFile(required("snapshot")),
			snapshot = JSON.parse(snapshotBytes.toString("utf8"));
		if (snapshot.manifestSha256 !== core.sha256(manifestBytes))
			throw new Error("Snapshot belongs to another manifest");
		if (!["dev", "test"].includes(values.split))
			throw new Error("--split must be dev or test");
		const cases = manifest.cases.filter((c) => c.split === values.split);
		if (!cases.length)
			throw new Error(
				"Selected split is empty; provide a verified document map before test evaluation",
			);
		const { dedupeLayoutRegions } = await server.ssrLoadModule(
			"/src/lib/pdf/layout/dedupe.ts",
		);
		const results = cases.map((record) => {
			const inputs = snapshot.pages.filter(
				(p) => p.imagePath === record.imagePath,
			);
			if (inputs.length !== 1)
				throw new Error(`Missing/duplicate snapshot page: ${record.imagePath}`);
			const inference = pipeline.inferHeuristicAssociations(inputs[0].blocks);
			const raw = inference.regions;
			if (raw.some((r) => r.pageIndex !== 0))
				throw new Error(
					`Snapshot page must be local page 0: ${record.imagePath}`,
				);
			const before = dedupeLayoutRegions(raw),
				after = inference.merged;
			return {
				imagePath: record.imagePath,
				targets: record.targets,
				warnings: record.warnings,
				before50: core.scoreCase(before, record, 0.5),
				before80: core.scoreCase(before, record, 0.8),
				after50: core.scoreCase(after, record, 0.5),
				after80: core.scoreCase(after, record, 0.8),
				raw,
				objects: inference.objects,
				links: inference.links,
			};
		});
		const summary = Object.fromEntries(
			["before50", "before80", "after50", "after80"].map((key) => [
				key,
				core.totals(results.map((r) => r[key])),
			]),
		);
		const report = {
			gitHead,
			algorithmSha256: core.sha256(
				(
					await Promise.all(
						(
							await readdir(path.join(root, "src/lib/pdf/layout"))
						)
							.filter((name) => name.endsWith(".ts"))
							.sort()
							.map((name) =>
								readFile(path.join(root, "src/lib/pdf/layout", name)),
							),
					)
				)
					.map((bytes) => core.sha256(bytes))
					.join("\n"),
			),
			harnessSha256: core.sha256(
				(
					await Promise.all(
						["core.ts", "pipeline.ts", "run.mjs"].map((name) =>
							readFile(path.join(root, "scripts/omnidocbench-bbox", name)),
						),
					)
				)
					.map((bytes) => core.sha256(bytes))
					.join("\n"),
			),
			worktreeDirty: Boolean(
				execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
					cwd: root,
					encoding: "utf8",
				}).trim(),
			),
			manifestSha256: core.sha256(manifestBytes),
			snapshotSha256: core.sha256(snapshotBytes),
			split: values.split,
			inputMode: snapshot.inputMode,
			summary,
			results,
		};
		await save(path.join(required("out"), "report.json"), report);
		if (values.images) {
			for (const [index, result] of results.entries()) {
				const record = cases.find((c) => c.imagePath === result.imagePath);
				const bytes = await readFile(inside(values.images, result.imagePath));
				const captured = snapshot.pages.find(
					(p) => p.imagePath === result.imagePath,
				);
				if (captured.imageSha256 !== core.sha256(bytes))
					throw new Error(`Image changed since capture: ${result.imagePath}`);
				const uri = `data:image/${bytes[0] === 137 ? "png" : "jpeg"};base64,${bytes.toString("base64")}`;
				for (const stage of ["before80", "after80"]) {
					const rects = (items, color) =>
						items
							.map(
								({ bbox: b }) =>
									`<rect x="${b.x * record.width}" y="${b.y * record.height}" width="${b.w * record.width}" height="${b.h * record.height}" fill="none" stroke="${color}" stroke-width="3"/>`,
							)
							.join("");
					const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${record.width}" height="${record.height}" viewBox="0 0 ${record.width} ${record.height}"><title>Green: ground truth crop; red: ${stage} predictions</title><image href="${uri}" width="${record.width}" height="${record.height}"/>${rects(result.targets, "#059669")}${rects(result[stage].predictions, "#dc2626")}</svg>`;
					await writeFile(
						path.join(required("out"), `page-${index + 1}-${stage}.svg`),
						svg,
					);
				}
			}
		}
		await writeFile(
			path.join(required("out"), "report.md"),
			`# BBox fusion evaluation\n\nSplit: ${values.split}; input: ${snapshot.inputMode}; pages: ${results.length}; commit: ${gitHead}\n\nAll results are crop-box detection F1, not caption-link or panel-membership accuracy. The no-merge baseline includes confidence/area/NMS filtering.\n\n| Stage | TP | FP | FN | Precision | Recall | F1 |\n|---|---:|---:|---:|---:|---:|---:|\n${Object.entries(
				summary,
			)
				.map(
					([name, s]) =>
						`| ${name} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.precision?.toFixed(3) ?? "n/a"} | ${s.recall?.toFixed(3) ?? "n/a"} | ${s.f1?.toFixed(3) ?? "n/a"} |`,
				)
				.join(
					"\n",
				)}\n\n| Page | GT | After TP@.8 | FP | FN |\n|---|---:|---:|---:|---:|\n${results.map((r) => `| ${r.imagePath} | ${r.targets.length} | ${r.after80.tp} | ${r.after80.fp} | ${r.after80.fn} |`).join("\n")}\n`,
		);
		console.log(JSON.stringify(summary, null, 2));
		if (values.images)
			await writeFile(
				path.join(required("out"), "overlays.md"),
				`# Crop overlays\n\nGreen = ground truth; red = predictions. Each pair uses the same frozen input.\n\n${results.map((r, i) => `## ${r.imagePath}\n\nBefore fusion:\n\n![Before](page-${i + 1}-before80.svg)\n\nAfter fusion:\n\n![After](page-${i + 1}-after80.svg)\n`).join("\n")}`,
			);
	}
} finally {
	await server.close();
}
