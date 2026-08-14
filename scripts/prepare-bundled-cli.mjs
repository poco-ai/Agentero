/**
 * Prepare Agentero's bundled desktop binaries with the target-triple suffix
 * required by Tauri `bundle.externalBin`:
 * - `agentero-cli` (headless Vault CLI)
 * - `agentero-voice-sidecar` (single-user realtime signaling)
 *
 * Usage:
 *   node scripts/prepare-bundled-cli.mjs           # debug (default)
 *   node scripts/prepare-bundled-cli.mjs --release
 *   node scripts/prepare-bundled-cli.mjs --stub    # tiny non-empty placeholder for typecheck
 *   node scripts/prepare-bundled-cli.mjs --ensure  # CLI stub + real debug Voice sidecar
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const release = process.argv.includes("--release");
const stub = process.argv.includes("--stub");
const ensure = process.argv.includes("--ensure");
const isWin = process.platform === "win32";
const ext = isWin ? ".exe" : "";

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

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const tauriPlatform = process.env.TAURI_ENV_PLATFORM || "";
// Mobile never ships the headless CLI (remote client only). Building it under
// iOS/Android env also pollutes native toolchains (e.g. tesseract/cmake).
const isMobile =
	tauriPlatform === "android" ||
	tauriPlatform === "ios" ||
	/-android|-ios\b/.test(triple);
const outDir = path.join(root, "src-tauri", "binaries");
fs.mkdirSync(outDir, { recursive: true });
// Mobile triples use the host executable extension rules poorly; always omit .exe.
const destExt = isMobile ? "" : ext;
const cliDest = path.join(outDir, `agentero-cli-${triple}${destExt}`);
const voiceDest = path.join(
	outDir,
	`agentero-voice-sidecar-${triple}${destExt}`,
);

/** Non-empty placeholder so Tauri build-script accepts `externalBin`. */
function writeStub(target, name) {
	const body = isWin
		? `@echo off\r\necho ${name} stub\r\nexit /b 1\r\n`
		: `#!/bin/sh\necho '${name} stub' >&2\nexit 1\n`;
	fs.writeFileSync(target, body);
	try {
		fs.chmodSync(target, 0o755);
	} catch {
		// windows
	}
}

function needsSeed(target) {
	return !fs.existsSync(target) || fs.statSync(target).size === 0;
}

if (ensure) {
	// For `tauri dev`, the CLI can stay a compile-time placeholder, while Voice
	// must be a real executable because the Host launches it on demand.
	if (needsSeed(cliDest)) {
		writeStub(cliDest, "agentero-cli");
		console.log(`[prepare-bundled-cli] ensure seeded stub → ${cliDest}`);
	} else {
		console.log(`[prepare-bundled-cli] ensure ok → ${cliDest}`);
	}
	if (needsSeed(voiceDest)) {
		writeStub(voiceDest, "agentero-voice-sidecar");
	}
}

if (stub) {
	writeStub(cliDest, "agentero-cli");
	writeStub(voiceDest, "agentero-voice-sidecar");
	console.log(`[prepare-bundled-cli] stub → ${cliDest}`);
	console.log(`[prepare-bundled-cli] stub → ${voiceDest}`);
	process.exit(0);
}

// Mobile platform configs clear externalBin; if this script still runs (e.g.
// shared beforeBuildCommand), never compile the desktop CLI under mobile env.
if (isMobile) {
	writeStub(cliDest, "agentero-cli");
	writeStub(voiceDest, "agentero-voice-sidecar");
	console.log(
		`[prepare-bundled-cli] mobile (${tauriPlatform || triple}): desktop binary stubs only`,
	);
	process.exit(0);
}

// Fresh trees have no externalBin artifact; Tauri build-script fails while
// compiling agentero_lib (dependency of agentero-cli). Seed a stub first,
// then overwrite with the real binary after cargo build.
for (const [target, name] of [
	[cliDest, "agentero-cli"],
	[voiceDest, "agentero-voice-sidecar"],
]) {
	if (needsSeed(target)) {
		writeStub(target, name);
		console.log(`[prepare-bundled-cli] seeded stub for compile → ${target}`);
	}
}

const profile = release ? "release" : "debug";
const releaseFlag = release ? " --release" : "";

function buildAndStage({ name, command, dest }) {
	console.log(`[prepare-bundled-cli] ${command}${releaseFlag}`);
	execSync(`${command}${releaseFlag}`, { cwd: root, stdio: "inherit" });
	const src = path.join(root, "target", profile, `${name}${ext}`);
	if (!fs.existsSync(src)) {
		throw new Error(`[prepare-bundled-cli] missing ${src}`);
	}
	const stat = fs.statSync(src);
	if (stat.size < 1024) {
		throw new Error(
			`[prepare-bundled-cli] ${src} is too small (${stat.size} bytes); refusing`,
		);
	}
	fs.copyFileSync(src, dest);
	try {
		fs.chmodSync(dest, 0o755);
	} catch {
		// windows
	}
	console.log(`[prepare-bundled-cli] ${src} → ${dest}`);
}

if (!ensure) {
	buildAndStage({
		name: "agentero-cli",
		command: "cargo build -p agentero-cli",
		dest: cliDest,
	});
}
buildAndStage({
	name: "agentero-voice-sidecar",
	command: "cargo build -p agentero --bin agentero-voice-sidecar",
	dest: voiceDest,
});
