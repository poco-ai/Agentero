/**
 * Stage the platform PDFium shared library into src-tauri/pdfium/ so Tauri can
 * bundle it (macOS `bundle.macOS.frameworks`, Windows/Linux `bundle.resources`).
 *
 * liteparse dlopens PDFium at runtime. Its build script bakes an absolute path
 * into the binary that only exists on the build machine, so a packaged app on a
 * user machine finds nothing and panics. See docs/backend/paper-import.md.
 *
 * PDFIUM_RELEASE_TAG must match liteparse-pdfium-sys's build.rs — bump it when
 * upgrading the `liteparse` dependency in crates/agentero-core/Cargo.toml.
 *
 * Usage:
 *   node scripts/prepare-pdfium.mjs
 *   node scripts/prepare-pdfium.mjs --extract <dir>
 *
 * `--extract` unpacks the full archive (library + headers) into <dir> without
 * touching src-tauri/pdfium; CI uses it to provision the build-script cache and
 * runtime search paths from one tag definition.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PDFIUM_RELEASE_TAG = "chromium/8058";
const PDFIUM_RELEASE_URL =
	"https://github.com/run-llama/pdfium-binaries/releases/download";
const PDFIUM_RELEASE_API =
	"https://api.github.com/repos/run-llama/pdfium-binaries/releases";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "src-tauri", "pdfium");

fs.mkdirSync(outDir, { recursive: true });

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

// Mobile parses PDFs on the paired desktop Host; src-tauri/Cargo.toml gates
// liteparse out of iOS/Android builds entirely.
if (
	tauriPlatform === "android" ||
	tauriPlatform === "ios" ||
	/-android|-ios\b/.test(triple)
) {
	console.log(
		`[prepare-pdfium] mobile (${tauriPlatform || triple}): nothing to stage`,
	);
	process.exit(0);
}

/** Mirrors `pdfium_asset_stem` in liteparse-pdfium-sys/build.rs. */
const ASSETS = {
	"aarch64-apple-darwin": "pdfium-mac-arm64",
	"x86_64-apple-darwin": "pdfium-mac-x64",
	"x86_64-unknown-linux-gnu": "pdfium-linux-x64",
	"x86_64-unknown-linux-musl": "pdfium-linux-musl-x64",
	"aarch64-unknown-linux-gnu": "pdfium-linux-arm64",
	"aarch64-unknown-linux-musl": "pdfium-linux-arm64",
	"armv7-unknown-linux-gnueabihf": "pdfium-linux-arm",
	"x86_64-pc-windows-msvc": "pdfium-win-x64",
	"x86_64-pc-windows-gnu": "pdfium-win-x64",
	"aarch64-pc-windows-msvc": "pdfium-win-arm64",
	"i686-pc-windows-msvc": "pdfium-win-x86",
	"i686-pc-windows-gnu": "pdfium-win-x86",
};

const asset = ASSETS[triple];
if (!asset) {
	console.error(`[prepare-pdfium] unsupported target: ${triple}`);
	process.exit(1);
}

const isWin = triple.includes("windows");
const isMac = triple.includes("apple-darwin");
const libName = isWin
	? "pdfium.dll"
	: isMac
		? "libpdfium.dylib"
		: "libpdfium.so";
const dest = path.join(outDir, libName);

/** Mirrors `dirs_cache` in liteparse-pdfium-sys/build.rs. */
function cacheRoot() {
	if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
	if (isWin) {
		return (
			process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
		);
	}
	return isMac
		? path.join(os.homedir(), "Library", "Caches")
		: path.join(os.homedir(), ".cache");
}

const cacheDir = path.join(
	cacheRoot(),
	"pdfium-rs",
	PDFIUM_RELEASE_TAG.replace("/", "_"),
	asset,
);
// pdfium-binaries puts the Windows DLL in bin/, the Unix shared library in lib/.
const cacheLibDir = path.join(cacheDir, isWin ? "bin" : "lib");

function candidateDirs() {
	const dirs = [];
	if (process.env.PDFIUM_LIB_PATH) dirs.push(process.env.PDFIUM_LIB_PATH);
	dirs.push(cacheLibDir);
	return dirs;
}

function findStaged() {
	for (const dir of candidateDirs()) {
		const candidate = path.join(dir, libName);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function githubToken() {
	return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

function authHeaders() {
	const token = githubToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * GitHub's release download endpoint intermittently answers 500/504 while the
 * REST API stays healthy, so retry transient failures instead of failing CI on
 * a single hiccup.
 */
async function fetchWithRetry(url, options = {}, attempts = 3) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		let response;
		try {
			response = await fetch(url, options);
		} catch (error) {
			lastError = error;
		}
		if (response) {
			if (response.ok) return response;
			lastError = new Error(`GET ${url}: HTTP ${response.status}`);
			const transient = response.status >= 500 || response.status === 429;
			await response.body?.cancel?.();
			if (!transient) throw lastError;
		}
		if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1));
	}
	throw lastError;
}

async function extractArchive(response) {
	const tmp = `${cacheDir}.tmp`;
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.mkdirSync(tmp, { recursive: true });
	const archive = path.join(tmp, "pdfium.tgz");
	fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
	execFileSync("tar", ["-xzf", archive, "-C", tmp], { stdio: "inherit" });
	fs.rmSync(archive, { force: true });
	fs.rmSync(cacheDir, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
	fs.renameSync(tmp, cacheDir);
	console.log(`[prepare-pdfium] cached at ${cacheDir}`);
}

/** Resolve the same archive through the release asset API, which redirects to a
 * different download service than the `releases/download` URL. */
async function assetApiUrl() {
	const tag = encodeURIComponent(PDFIUM_RELEASE_TAG);
	const response = await fetchWithRetry(
		`${PDFIUM_RELEASE_API}/tags/${tag}`,
		{ headers: authHeaders() },
		2,
	);
	const release = await response.json();
	const match = release.assets?.find((entry) => entry.name === `${asset}.tgz`);
	if (!match) {
		throw new Error(`${PDFIUM_RELEASE_TAG} has no ${asset}.tgz asset`);
	}
	return match.url;
}

async function download() {
	const directUrl = `${PDFIUM_RELEASE_URL}/${PDFIUM_RELEASE_TAG.replace("/", "%2F")}/${asset}.tgz`;
	console.log(`[prepare-pdfium] GET ${directUrl}`);
	try {
		await extractArchive(await fetchWithRetry(directUrl));
		return;
	} catch (error) {
		console.warn(
			`[prepare-pdfium] release download failed (${error.message}); retrying via the asset API`,
		);
	}
	const url = await assetApiUrl();
	console.log(`[prepare-pdfium] GET ${url}`);
	await extractArchive(
		await fetchWithRetry(url, {
			headers: { Accept: "application/octet-stream", ...authHeaders() },
		}),
	);
}

const extractIndex = process.argv.indexOf("--extract");
if (extractIndex !== -1) {
	const dest = process.argv[extractIndex + 1];
	if (!dest) {
		console.error("[prepare-pdfium] --extract needs a destination directory");
		process.exit(1);
	}
	if (
		!fs.existsSync(path.join(cacheDir, "include")) ||
		!fs.existsSync(path.join(cacheLibDir, libName))
	) {
		await download();
	}
	const extractedLib = path.join(cacheLibDir, libName);
	if (!fs.existsSync(extractedLib)) {
		console.error(`[prepare-pdfium] ${extractedLib} missing after download`);
		process.exit(1);
	}
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.cpSync(cacheDir, dest, { recursive: true });
	console.log(`[prepare-pdfium] extracted ${asset} to ${dest}`);
	process.exit(0);
}

let src = findStaged();
if (!src) {
	await download();
	src = findStaged();
}
if (!src) {
	console.error(`[prepare-pdfium] ${libName} not found after download`);
	process.exit(1);
}

// A truncated dylib would ship a broken installer, so refuse implausible sizes.
const size = fs.statSync(src).size;
if (size < 1024 * 1024) {
	console.error(`[prepare-pdfium] ${src} is only ${size} bytes; refusing`);
	process.exit(1);
}

if (!fs.existsSync(dest) || fs.statSync(dest).size !== size) {
	if (fs.existsSync(dest)) {
		fs.rmSync(dest, { force: true });
	}
	fs.copyFileSync(src, dest);
	fs.chmodSync(dest, 0o644);
} else {
	try {
		fs.chmodSync(dest, 0o644);
	} catch {}
}

// pdfium-binaries ships an install name of `./libpdfium.dylib`; codesign and
// @rpath resolution inside Contents/Frameworks need the @rpath form.
if (isMac) {
	try {
		execFileSync("install_name_tool", ["-id", "@rpath/libpdfium.dylib", dest]);
	} catch (error) {
		console.warn(`[prepare-pdfium] install_name_tool failed: ${error}`);
	}
}

console.log(`[prepare-pdfium] ${src} → ${dest} (${size} bytes)`);
