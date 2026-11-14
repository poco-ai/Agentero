/** Build the bundled, read-only dictionary. No dictionary download at runtime. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
	fs.readFileSync(path.join(root, "resources/dictionary/sources.json"), "utf8"),
);
const out = path.join(root, "src-tauri/dictionary");
const output = path.join(out, "lexicon.sqlite");
const termsPath = path.join(root, "src/lib/translate/data/ai-terms.json");
const terms = JSON.parse(fs.readFileSync(termsPath, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const version = hash(
	`${JSON.stringify(manifest)}${JSON.stringify(terms)}schema-2`,
);
const stamp = path.join(out, "version.txt");
// Mirrors frontend normalizeTermKey and core glossary::lookup_key.
const lookupKey = (text) =>
	text
		.replace(/[\p{White_Space}\u2010-\u2015\u2212-]+/gu, " ")
		.trim()
		.toLowerCase();

function verify() {
	const db = new DatabaseSync(output, { readOnly: true });
	try {
		const count = db
			.prepare("SELECT COUNT(*) AS n FROM entries WHERE source = 'ecdict'")
			.get().n;
		if (count < 700000)
			throw new Error(`Incomplete dictionary: ${count} entries`);
		for (const query of [
			"attention",
			"resolution",
			"kv cache",
			"llm",
			"transformer",
		]) {
			if (
				!db.prepare("SELECT 1 FROM entries WHERE lookup = ? LIMIT 1").get(query)
			)
				throw new Error(`Missing dictionary entry: ${query}`);
		}
		console.log(
			`[dictionary] verified ${count} ECDICT entries + ${terms.length} AI terms (${(fs.statSync(output).size / 1048576).toFixed(1)} MB)`,
		);
	} finally {
		db.close();
	}
}

if (
	fs.existsSync(output) &&
	fs.existsSync(stamp) &&
	fs.readFileSync(stamp, "utf8") === version
) {
	verify();
} else {
	if (process.argv.includes("--verify"))
		throw new Error(
			"Dictionary not staged or outdated; run pnpm dictionary:stage",
		);
	const source = manifest.ecdict;
	const cache = path.join(os.tmpdir(), "agentero-dictionary-inputs");
	fs.mkdirSync(cache, { recursive: true });
	const cached = path.join(cache, `${source.sha256}.csv`);
	let bytes = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
	if (!bytes || hash(bytes) !== source.sha256) {
		let failure;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const res = await fetch(source.url, {
					signal: AbortSignal.timeout(180000),
				});
				if (!res.ok) throw new Error(`Dictionary download: HTTP ${res.status}`);
				bytes = Buffer.from(await res.arrayBuffer());
				if (hash(bytes) !== source.sha256)
					throw new Error("Dictionary checksum mismatch");
				fs.writeFileSync(cached, bytes);
				failure = null;
				break;
			} catch (e) {
				failure = e;
			}
		}
		if (failure) throw failure;
	}
	fs.mkdirSync(out, { recursive: true });
	const temporary = `${output}.${process.pid}.tmp`;
	const db = new DatabaseSync(temporary);
	try {
		db.exec(
			"PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE entries(lookup TEXT, word TEXT, phonetic TEXT, translation TEXT, definition TEXT, source TEXT, source_url TEXT, priority INTEGER, PRIMARY KEY(lookup,source,word)) WITHOUT ROWID; CREATE TABLE aliases(lookup TEXT, canonical TEXT, PRIMARY KEY(lookup,canonical)) WITHOUT ROWID; BEGIN",
		);
		const insert = db.prepare(
			"INSERT OR IGNORE INTO entries VALUES(?,?,?,?,?,?,?,?)",
		);
		const alias = db.prepare("INSERT OR IGNORE INTO aliases VALUES(?,?)");
		for (const row of parse(bytes, {
			columns: true,
			skip_empty_lines: true,
			bom: true,
		})) {
			const word = row.word.trim();
			if (!word) continue;
			const key = lookupKey(word);
			insert.run(
				key,
				word,
				row.phonetic || "",
				(row.translation || "").replaceAll("\\n", "\n"),
				(row.definition || "").replaceAll("\\n", "\n"),
				"ecdict",
				"",
				0,
			);
			for (const form of (row.exchange || "").split("/")) {
				const [kind, value] = form.split(":");
				if (value && kind !== "0" && kind !== "1")
					alias.run(lookupKey(value), key);
			}
		}
		for (const term of terms) {
			for (const name of term.aliases)
				insert.run(
					lookupKey(name),
					name,
					"",
					`${term.translation}\n${term.definition}`,
					"",
					term.source || "ai-glossary",
					term.url,
					10,
				);
		}
		db.exec("COMMIT; PRAGMA user_version=2; VACUUM");
	} finally {
		db.close();
	}
	fs.renameSync(temporary, output);
	for (const name of [
		"ECDICT-LICENSE.txt",
		"AI-GLOSSARY-LICENSE.txt",
		"sources.json",
	])
		fs.copyFileSync(
			path.join(root, "resources/dictionary", name),
			path.join(out, name),
		);
	fs.writeFileSync(stamp, version);
	verify();
}
