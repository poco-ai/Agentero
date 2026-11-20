// Run the distributed binary against an isolated Vault, using its packaged PDFium.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [binaryArg, libraryArg] = process.argv.slice(2);
if (!binaryArg || !libraryArg) throw new Error("expected CLI and PDFium paths");
const binary = path.resolve(binaryArg);
const library = path.resolve(libraryArg);
const version = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const fixture = path.join(
	root,
	"src/lib/writing/templates/vendor/icml/icml_numpapers.pdf",
);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentero-package-"));
const vault = path.join(scratch, "Smoke Vault");
const env = {
	...process.env,
	XDG_CONFIG_HOME: path.join(scratch, "config"),
	XDG_DATA_HOME: path.join(scratch, "data"),
	XDG_CACHE_HOME: path.join(scratch, "cache"),
};
delete env.PDFIUM_LIB_PATH;
delete env.AGENTERO_VAULT;
delete env.AGENTERO_CONTEXT_GRANT;

function cli(...args) {
	return execFileSync(binary, args, {
		cwd: scratch,
		env,
		encoding: "utf8",
		timeout: 120_000,
	});
}

try {
	assert.ok(fs.statSync(library).size > 0, library);
	assert.equal(cli("--version").trim().split(/\s+/).at(-1), version);
	cli("--no-input", "vault", "create", vault);
	const run = (...args) =>
		JSON.parse(cli("--vault", vault, "--json", "--no-input", ...args));
	run("paper", "import", "pdf", fixture, "--no-recognize");
	const [paper] = run("paper", "list").items;
	// With no layout sidecar, page reads go through in-process PDFium.
	assert.ok(
		!fs.existsSync(path.join(vault, paper.path, "source", "layout.json")),
	);
	// The loader tries an explicit file and then the packaged library. A
	// deliberately invalid first candidate prevents a missing package path
	// from being masked by PDFium in the build runner's compiler cache.
	fs.writeFileSync(
		path.join(scratch, path.basename(library)),
		"invalid PDFium",
	);
	env.PDFIUM_LIB_PATH = scratch;
	const result = run("read", paper.path, "--page", "1");
	run("paper", "extract", paper.path, "--refresh");
	assert.match(
		fs.readFileSync(path.join(vault, paper.path, "PAPER.md"), "utf8"),
		/Conference\/Workshop Year|Ann\s+Arbor/i,
	);
	assert.match(result.text, /Ann\s+Arbor/i);
	assert.equal(result.evidence[0].locator.page, 1);
	console.log(
		`Verified ${binary} (${fs.statSync(binary).size} bytes), version ${version}, physical PDF page 1 and isolated text extraction`,
	);
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
