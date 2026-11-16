import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";
import { build } from "vite";
import { layoutPng } from "../../test/helpers/layout-png.ts";
import { problems, readAnnotation } from "./model.ts";

const { values } = parseArgs({
	options: {
		pdf: { type: "string" },
		pages: { type: "string" },
		out: { type: "string" },
		title: { type: "string" },
		source: { type: "string", default: "" },
		help: { type: "boolean" },
		example: { type: "string" },
	},
});
if (values.help || !values.pdf || !values.out) {
	console.log(
		"node scripts/bbox-annotator/prepare.mjs --pdf paper.pdf --out tmp/paper-annotator.html [--pages 3,8,9,18,21] [--title title] [--source URL]\nPages are 1-based. Omit --pages to include every page. Output is a standalone offline HTML file. Requires Node 24 and installed project dependencies.",
	);
	process.exit(values.help ? 0 : 1);
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) =>
	JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
const bytes = await readFile(resolve(values.pdf));
const pdfSha256 = hash(bytes);
const pdf = new PdfiumNative(
	await init({
		wasmBinary: await readFile(
			fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
		),
	}),
	{ fontFallback: null },
);
let doc;
const pages = [];
try {
	doc = await pdf
		.openDocumentBuffer({
			id: pdfSha256,
			content: bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			),
		})
		.toPromise();
	const numbers = values.pages
		? values.pages.split(",").map((p) => Number(p.trim()))
		: doc.pages.map((p) => p.index + 1);
	if (
		!numbers.length ||
		numbers.some(
			(n) => !Number.isInteger(n) || n < 1 || n > doc.pages.length,
		) ||
		new Set(numbers).size !== numbers.length
	)
		throw new Error(
			`Pages must be unique integers from 1 to ${doc.pages.length}`,
		);
	for (const number of numbers.sort((a, b) => a - b)) {
		const page = doc.pages[number - 1];
		const image = await pdf
			.renderPageRaw(doc, page, { scaleFactor: 2 })
			.toPromise();
		const png = layoutPng(image);
		pages.push({
			pageIndex: number - 1,
			width: image.width,
			height: image.height,
			image: `data:image/png;base64,${png.toString("base64")}`,
			imageSha256: hash(png),
		});
		console.log(`Rendered page ${number}/${doc.pages.length}`);
	}
} finally {
	if (doc) await pdf.closeDocument(doc).toPromise();
	await pdf.destroy().toPromise();
}
const task = {
	id: hash(
		json({
			pdfSha256,
			pages: pages.map(({ image: _image, ...p }) => p),
			rulesVersion: "1.0.0",
		}),
	),
	pdfSha256,
	title: values.title || values.pdf.split(/[\\/]/).pop(),
	source: values.source,
	rulesVersion: "1.0.0",
	pages,
};
if (values.example) {
	const example = JSON.parse(await readFile(resolve(values.example), "utf8"));
	if (example.pdfSha256 !== pdfSha256)
		throw new Error("Example PDF hash differs from the source PDF");
	task.example = readAnnotation({ ...example, taskId: task.id }, task);
	const errors = problems(task.example, task);
	if (errors.length)
		throw new Error(
			`Example has incomplete annotations: ${JSON.stringify(errors)}`,
		);
}
const result = await build({
	configFile: false,
	root: fileURLToPath(new URL(".", import.meta.url)),
	define: { "process.env.NODE_ENV": '"production"' },
	build: {
		write: false,
		minify: true,
		lib: {
			entry: fileURLToPath(new URL("app.tsx", import.meta.url)),
			name: "BboxLab",
			formats: ["iife"],
		},
		rollupOptions: { output: { inlineDynamicImports: true } },
	},
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(
	(r) => r.output,
);
const js = outputs
	.filter((o) => o.type === "chunk")
	.map((o) => o.code)
	.join("\n");
const css = outputs
	.filter((o) => o.type === "asset" && o.fileName.endsWith(".css"))
	.map((o) => o.source)
	.join("\n");
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>BBox annotation lab</title><style>${css.replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="root"></div><script type="application/json" id="task-data">${json(task)}</script><script>${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
const output = resolve(values.out);
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, html);
await writeFile(
	`${output}.manifest.json`,
	JSON.stringify(
		{ ...task, pages: task.pages.map(({ image: _image, ...p }) => p) },
		null,
		2,
	),
);
console.log(
	`Offline annotator: ${output}\n${pages.length} pages; ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB; task ${task.id}`,
);
