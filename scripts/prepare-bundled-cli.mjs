/**
 * Stage the headless CLI as an offline desktop resource. The binary in this
 * directory and the GUI use the same revision, target and profile.
 *
 * Usage:
 *   node scripts/prepare-bundled-cli.mjs           # debug (default)
 *   node scripts/prepare-bundled-cli.mjs --release
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const release = process.argv.includes("--release");

function hostTriple() {
	try {
		return execSync("rustc --print host-tuple", { encoding: "utf8" }).trim();
	} catch {
		const out = execSync("rustc -Vv", { encoding: "utf8" });
		const line = out.split("\n").find((l) => l.startsWith("host:"));
		if (!line) throw new Error("could not determine host triple");
		return line.split(/\s+/)[1];
	}
}

const host = hostTriple();
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || host;
const ext = triple.includes("windows") ? ".exe" : "";
const tauriPlatform = process.env.TAURI_ENV_PLATFORM || "";
// Mobile never ships the headless CLI (remote client only); building it under
// iOS/Android env also pollutes native toolchains (e.g. tesseract/cmake).
const isMobile =
	tauriPlatform === "android" ||
	tauriPlatform === "ios" ||
	/-android|-ios\b/.test(triple);
if (isMobile) {
	console.log(
		`[prepare-bundled-cli] mobile (${tauriPlatform || triple}): skipped (CLI is desktop-only)`,
	);
	process.exit(0);
}

// Tauri signs externalBin executables individually inside Contents/MacOS.
const mac = triple.endsWith("-apple-darwin");
const outDir = path.join(root, "src-tauri", mac ? "sidecars" : "cli");
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(
	outDir,
	mac ? `agentero-turn-${triple}` : `agentero-cli${ext}`,
);

const profile = release ? "release" : "debug";
console.log(
	`[prepare-bundled-cli] cargo build -p agentero-cli${release ? " --release" : ""}`,
);
const cross = triple !== host;
const args = ["build", "--locked", "-p", "agentero-cli"];
if (release) args.push("--release");
if (cross) args.push("--target", triple);
execFileSync("cargo", args, { cwd: root, stdio: "inherit" });
const targetDir = process.env.CARGO_TARGET_DIR || path.join(root, "target");
const src = path.resolve(
	root,
	targetDir,
	cross ? triple : "",
	profile,
	`agentero-cli${ext}`,
);
if (!fs.existsSync(src)) {
	console.error(`[prepare-bundled-cli] missing ${src}`);
	process.exit(1);
}
// Refuse to stage a broken empty artifact.
const st = fs.statSync(src);
if (st.size < 1024) {
	console.error(
		`[prepare-bundled-cli] ${src} is too small (${st.size} bytes); refusing`,
	);
	process.exit(1);
}
fs.copyFileSync(src, dest);
try {
	fs.chmodSync(dest, 0o755);
} catch {
	// windows
}
console.log(`[prepare-bundled-cli] ${src} → ${dest}`);
