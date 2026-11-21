import { appCacheDir, join } from "@tauri-apps/api/path";
import { logOp } from "@/lib/core/logger";
import { readVaultBytes, writeVaultBytes } from "@/lib/vault/fs";
import type { FontKey } from "./types";
export type ReflowFontBytes = Record<FontKey, Uint8Array>;
/**
 * Same OFL font assets across platforms, mirrored on ModelScope; the dataset
 * revision pins the upstream commit while the hashes pin the content.
 */
const revision = "b956e9333a4e53ed9753c296877af6c7074d7b23";
const assets: Record<FontKey, [string, string]> = {
	regular: [
		"NotoSerif-Regular.ttf",
		"76b746ed54a2f83fa41db9a85a43b4b39900dbdb8ae40ec3d93950b0b00c4bd7",
	],
	bold: [
		"NotoSerif-Bold.ttf",
		"2015eba9ca7ca5cf7320bd5e6740439f84b55eefad7208e63b9b6d32e8c82410",
	],
	italic: [
		"NotoSerif-Italic.ttf",
		"be429bb62448b615f62cf7817d6a801fbc209e6cd2c11ffa15801f6d7dfac7cf",
	],
	boldItalic: [
		"NotoSerif-BoldItalic.ttf",
		"c49e9f86cc43e05e8e5e8da53a7e00568fac08e2afb93b0d7979a2ea94fd6171",
	],
	cjk: [
		"SourceHanSerifCN-Regular.ttf",
		"8ba5ec09db04b1d1599edeff3fb5627ca11eaaf85e339e5c32684cb94e806993",
	],
	cjkBold: [
		"SourceHanSerifCN-Bold.ttf",
		"fafd6dc09a0ba3be1ac224aec3ff0befab97964c4ffba6b16f789702106577aa",
	],
};
async function sha256(bytes: Uint8Array): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)),
		(n) => n.toString(16).padStart(2, "0"),
	).join("");
}
let pending: Promise<ReflowFontBytes> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;

export function loadReflowFonts(): Promise<ReflowFontBytes> {
	clearTimeout(idle);
	pending ??= logOp("pdf.reflow.fonts", undefined, async () => {
		const root = await join(await appCacheDir(), "pdf-fonts", revision);
		const entries = await Promise.all(
			(Object.entries(assets) as [FontKey, [string, string]][]).map(
				async ([key, [name, hash]]) => {
					const path = await join(root, name);
					try {
						const bytes = await readVaultBytes(path);
						if ((await sha256(bytes)) === hash) return [key, bytes] as const;
					} catch {
						/* Missing cache: fetch a pinned public font. */
					}
					const response = await fetch(
						`https://www.modelscope.cn/datasets/awwaawwa/BabelDOCAssets/resolve/${revision}/fonts/${name}`,
						{ credentials: "omit", signal: AbortSignal.timeout(60_000) },
					);
					if (!response.ok)
						throw new Error(
							`Font download failed: ${name} (${response.status})`,
						);
					const bytes = new Uint8Array(await response.arrayBuffer());
					if ((await sha256(bytes)) !== hash)
						throw new Error(`Font checksum mismatch: ${name}`);
					await writeVaultBytes(path, bytes);
					return [key, bytes] as const;
				},
			),
		);
		return Object.fromEntries(entries) as ReflowFontBytes;
	}).catch((error) => {
		pending = undefined;
		throw error;
	});
	const current = pending;
	void current.then(
		() => {
			if (pending !== current) return;
			clearTimeout(idle);
			idle = setTimeout(() => {
				pending = undefined;
			}, 30_000);
		},
		() => {},
	);
	return pending;
}
