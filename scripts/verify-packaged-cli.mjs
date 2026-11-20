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

function cli(executable, ...args) {
	return execFileSync(executable, args, {
		cwd: scratch,
		env,
		encoding: "utf8",
		timeout: 120_000,
	});
}

function run(executable, ...args) {
	return JSON.parse(
		cli(executable, "--vault", vault, "--json", "--no-input", ...args),
	);
}

function checkPdf(executable, paper) {
	const result = run(executable, "read", paper, "--page", "1");
	assert.match(result.text, /Ann\s+Arbor/i);
	assert.equal(result.evidence[0].locator.page, 1);
	run(executable, "paper", "extract", paper, "--refresh");
	assert.match(
		fs.readFileSync(path.join(vault, paper, "PAPER.md"), "utf8"),
		/Conference\/Workshop Year|Ann\s+Arbor/i,
	);
}

try {
	assert.ok(fs.statSync(library).size > 0, library);
	assert.equal(cli(binary, "--version").trim().split(/\s+/).at(-1), version);
	cli(binary, "--no-input", "vault", "create", vault);
	run(binary, "paper", "import", "pdf", fixture, "--no-recognize");
	const [paper] = run(binary, "paper", "list").items;
	// With no layout sidecar, page reads go through in-process PDFium.
	assert.ok(
		!fs.existsSync(path.join(vault, paper.path, "source", "layout.json")),
	);
	// An invalid explicit candidate prevents the compiler's PDFium cache
	// from masking a missing packaged library.
	fs.writeFileSync(
		path.join(scratch, path.basename(library)),
		"invalid PDFium",
	);
	env.PDFIUM_LIB_PATH = scratch;
	checkPdf(binary, paper.path);
	if (process.platform !== "win32") {
		const cache = path.join(scratch, "managed", version);
		const userBin = path.join(scratch, "user bin");
		fs.mkdirSync(cache, { recursive: true });
		fs.mkdirSync(userBin);
		const cached = path.join(cache, "agentero");
		fs.copyFileSync(binary, cached);
		fs.copyFileSync(library, path.join(cache, path.basename(library)));
		const shim = path.join(userBin, "agentero");
		fs.symlinkSync(cached, shim);
		checkPdf(shim, paper.path);
	}
	console.log(
		`Verified ${binary} (${fs.statSync(binary).size} bytes), version ${version}, physical PDF page 1 and isolated text extraction`,
	);
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
