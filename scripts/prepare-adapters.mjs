/**
 * Stage the bundled ACP adapters (JS-only dependency trees) into
 * `src-tauri/adapters/` so Tauri can ship them as app resources.
 *
 * The Claude/Codex ACP adapters are Node CLIs whose native host binaries live
 * in platform `optionalDependencies` (~220-320MB each). We stage only the JS
 * layer (`--omit=optional`): at runtime the host spawns `node <entry>.js` and
 * points the adapter at the user's own `claude`/`codex` via
 * `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` (see registry/bundled.rs). A
 * PATH-installed adapter always wins; the bundled tier is an offline fallback.
 *
 * Versions and transitive dependencies are locked in acp-adapters/.
 *
 * Usage:
 *   node scripts/prepare-adapters.mjs           # idempotent
 *   node scripts/prepare-adapters.mjs --force   # restage even if current
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const inputs = fileURLToPath(new URL("./acp-adapters/", import.meta.url));
const { dependencies } = JSON.parse(
	fs.readFileSync(path.join(inputs, "package.json"), "utf8"),
);
const lockDigest = createHash("sha256")
	.update(fs.readFileSync(path.join(inputs, "package-lock.json")))
	.digest("hex");
const NPM_OPTS = process.platform === "win32" ? { shell: true } : {};

const ADAPTERS = [
	{
		id: "claude-acp",
		package: "@agentclientprotocol/claude-agent-acp",
		entry: "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
		// claude-agent-acp engines: node >= 22
		nodeMajor: 22,
	},
	{
		id: "codex-acp",
		package: "@agentclientprotocol/codex-acp",
		entry: "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
		nodeMajor: null,
	},
].map((adapter) => ({ ...adapter, version: dependencies[adapter.package] }));

// Guards against a stray platform binary sneaking into the trees
const MAX_TOTAL_MB = Number(process.env.AGENTERO_ADAPTER_MAX_MB || 80);
const MAX_FILE_MB = 5;
const NATIVE_EXT = /\.(node|dylib|dll|so|exe)$/i;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "src-tauri", "adapters");

function hostTriple() {
	try {
		return execFileSync("rustc", ["--print", "host-tuple"], {
			encoding: "utf8",
		}).trim();
	} catch {
		const out = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
		const line = out.split("\n").find((l) => l.startsWith("host:"));
		if (!line) throw new Error("could not determine host triple");
		return line.split(/\s+/)[1];
	}
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const tauriPlatform = process.env.TAURI_ENV_PLATFORM || "";

// Mobile never runs local ACP agents; the trees are desktop-only resources.
if (
	tauriPlatform === "android" ||
	tauriPlatform === "ios" ||
	/-android|-ios\b/.test(triple)
) {
	console.log(
		`[prepare-adapters] mobile (${tauriPlatform || triple}): nothing to stage`,
	);
	process.exit(0);
}

function manifestPath() {
	return path.join(outDir, "manifest.json");
}

/** True when the staged output already matches the pinned versions. */
function isCurrent() {
	if (process.argv.includes("--force")) return false;
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
	} catch {
		return false;
	}
	if (manifest?.lockDigest !== lockDigest) return false;
	for (const adapter of ADAPTERS) {
		const entry = manifest?.adapters?.[adapter.id];
		if (entry?.version !== adapter.version) return false;
		const staged = path.join(outDir, adapter.entry);
		if (!fs.existsSync(staged)) return false;
	}
	return true;
}

if (isCurrent()) {
	console.log(
		`[prepare-adapters] ${manifestPath()} is current (pinned versions staged); use --force to restage`,
	);
	process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

// System npm in a throwaway dir keeps the pnpm workspace (lockfile, allowBuilds)
// untouched; --ignore-scripts neutralizes @openai/codex's postinstall and any
// other lifecycle hooks; --omit=optional drops the platform binary packages.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentero-adapters-"));
try {
	for (const name of ["package.json", "package-lock.json"]) {
		fs.copyFileSync(path.join(inputs, name), path.join(tmp, name));
	}
	console.log(
		`[prepare-adapters] npm ci (one tree so shared deps dedupe) in ${tmp}`,
	);
	execFileSync(
		"npm",
		[
			"ci",
			"--omit=optional",
			"--omit=dev",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
		],
		{ cwd: tmp, stdio: "inherit", ...NPM_OPTS },
	);

	for (const adapter of ADAPTERS) {
		const entry = path.join(tmp, adapter.entry);
		if (!fs.existsSync(entry)) {
			console.error(`[prepare-adapters] missing entry: ${entry}`);
			process.exit(1);
		}
	}

	// Drop npm's .bin shims: they are the only symlinks in the tree and the
	// runtime spawns `node <entry>.js` directly, never the shims.
	fs.rmSync(path.join(tmp, "node_modules", ".bin"), {
		recursive: true,
		force: true,
	});

	// A stray platform binary or symlink would silently break offline users or
	// the packaged layout; refuse to stage anything implausible.
	let totalBytes = 0;
	const walk = (dir) => {
		for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, item.name);
			if (item.isSymbolicLink()) {
				console.error(`[prepare-adapters] symlink in staged tree: ${full}`);
				process.exit(1);
			}
			if (item.isDirectory()) {
				walk(full);
				continue;
			}
			if (NATIVE_EXT.test(item.name)) {
				console.error(`[prepare-adapters] native file in staged tree: ${full}`);
				process.exit(1);
			}
			const size = fs.statSync(full).size;
			totalBytes += size;
			if (size > MAX_FILE_MB * 1024 * 1024) {
				console.error(
					`[prepare-adapters] ${full} is ${(size / 1024 / 1024).toFixed(1)}MB (> ${MAX_FILE_MB}MB); refusing`,
				);
				process.exit(1);
			}
		}
	};
	walk(path.join(tmp, "node_modules"));
	if (totalBytes > MAX_TOTAL_MB * 1024 * 1024) {
		console.error(
			`[prepare-adapters] staged tree is ${(totalBytes / 1024 / 1024).toFixed(1)}MB (> ${MAX_TOTAL_MB}MB); refusing (set AGENTERO_ADAPTER_MAX_MB to override)`,
		);
		process.exit(1);
	}

	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });
	// One shared tree: both adapters were installed together so common deps
	// deduplicate where version ranges allow; manifest `entry` paths are relative to
	// this adapters root.
	fs.cpSync(path.join(tmp, "node_modules"), path.join(outDir, "node_modules"), {
		recursive: true,
	});
	for (const adapter of ADAPTERS) {
		console.log(
			`[prepare-adapters] ${adapter.package}@${adapter.version} staged (entry ${adapter.entry})`,
		);
	}
	fs.writeFileSync(
		manifestPath(),
		`${JSON.stringify(
			{
				adapters: Object.fromEntries(
					ADAPTERS.map((a) => [
						a.id,
						{
							package: a.package,
							version: a.version,
							entry: a.entry,
							nodeMajor: a.nodeMajor,
						},
					]),
				),
				lockDigest,
				totalBytes,
			},
			null,
			"\t",
		)}\n`,
	);
	console.log(
		`[prepare-adapters] manifest → ${manifestPath()} (total ${(totalBytes / 1024 / 1024).toFixed(1)}MB)`,
	);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
