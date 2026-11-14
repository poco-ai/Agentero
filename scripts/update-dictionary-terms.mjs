/** Reproduce the small, licensed AI glossary snapshot; never fetch on user lookup. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { aiGlossary } = JSON.parse(
	fs.readFileSync(path.join(root, "resources/dictionary/sources.json"), "utf8"),
);
const pages = [
	"agents",
	"basic-concepts",
	"ecosystem-engineering",
	"evaluation-benchmarks",
	"fine-tuning",
	"inference-deployment",
	"model-architecture",
	"multimodal",
	"prompt-engineering",
	"rag-retrieval",
	"safety-alignment",
	"training",
];
const sourceDir = process.argv.indexOf("--source-dir");
const plain = (text) =>
	text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replaceAll("**", "")
		.replaceAll("`", "")
		.trim();
const terms = [];
for (const page of pages) {
	const url = `${aiGlossary.repository}/blob/${aiGlossary.revision}/docs/${page}.md`;
	let text;
	if (sourceDir >= 0)
		text = fs.readFileSync(
			path.join(process.argv[sourceDir + 1], "docs", `${page}.md`),
			"utf8",
		);
	else {
		const res = await fetch(
			url
				.replace("https://github.com/", "https://raw.githubusercontent.com/")
				.replace("/blob/", "/"),
			{ signal: AbortSignal.timeout(30000) },
		);
		if (!res.ok) throw new Error(`Glossary source HTTP ${res.status}: ${page}`);
		text = await res.text();
	}
	for (const block of text.split(/^### /m).slice(1)) {
		const lines = block.split(/\r?\n/);
		const header = lines[0].trim();
		const english = block.match(/\*\*英文\*\*：(.+?)\s*\|/)?.[1]?.trim();
		if (!english) throw new Error(`Unrecognized source entry: ${header}`);
		const aliases = english
			.replace(/\s*[（(].*?[)）]/g, "")
			.split(/\s*\/\s*/)
			.map((v) => v.trim());
		for (const match of english.matchAll(
			/[（(]([A-Za-z][A-Za-z0-9 -]{1,30})[)）]/g,
		))
			aliases.push(match[1]);
		if (/^[A-Za-z]/.test(header)) aliases.push(header.split(/[（(]/)[0].trim());
		let translation = /^[\u4e00-\u9fff]/.test(header)
			? header.split(/[（(]/)[0].trim()
			: header;
		if (header.startsWith("KV Cache")) translation = "键值缓存";
		if (aliases.includes("LLM")) translation = "大模型";
		const definition =
			block
				.trim()
				.split(/\r?\n\s*\r?\n/)
				.slice(1)
				.find((line) => !line.startsWith("**英文")) ||
			lines.slice(2).find((line) => line.trim() && !line.startsWith("**英文"));
		if (!definition) throw new Error(`Missing source definition: ${header}`);
		terms.push({
			aliases: [...new Set(aliases.filter((v) => v && v.length < 80))].sort(),
			translation,
			definition: plain(definition),
			url,
		});
	}
}
if (terms.length !== 148)
	throw new Error(`Unexpected snapshot size: ${terms.length}`);
const destination = path.join(root, "src/lib/translate/data/ai-terms.json");
const serialized = `${JSON.stringify(terms, null, "\t")}\n`;
if (process.argv.includes("--check")) {
	if (
		JSON.stringify(JSON.parse(fs.readFileSync(destination, "utf8"))) !==
		JSON.stringify(terms)
	)
		throw new Error("AI dictionary snapshot differs from the pinned sources");
} else fs.writeFileSync(destination, serialized);
console.log(
	`[dictionary] ${terms.length} entries reproduced from ${aiGlossary.revision}`,
);
