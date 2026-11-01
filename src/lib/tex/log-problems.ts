/**
 * Pull errors and warnings out of a LaTeX log so the writing bar can
 * show the same findings as the raw log.
 */

import { normalizePath } from "@/lib/core/path";
import { joinVaultPath } from "@/lib/vault/path";
import { manuscriptDir } from "@/lib/writing/session";

export type LogProblem = {
	severity: "error" | "warning";
	message: string;
	file?: string;
	line?: number;
	logLine: number;
};

// `-file-line-error` puts the file before `:line:`. latexmk hands TeX the root
// file as an absolute path, so that name can start with a drive letter. A name
// that starts with `/`, `./`, `../`, a drive or `\\` may contain spaces; a bare
// one may not, so source text echoed on TeX's context lines (`l.12 …`) is not
// read as a file name.
const FILE_LINE =
	/^((?:(?:\.{0,2}\/|\.{1,2}\\|[A-Za-z]:[\\/]|\\\\)[^:"]*?|[^\s:"]+?)\.(?:tex|sty|cls|bib)):(\d+):\s+(.+)$/i;
const WARNING = /^(?:LaTeX|Class|Package)(?: \S+)? Warning:\s*(.*)$/;
const BOX = /^(?:Overfull|Underfull) \\[hv]box .* at lines (\d+)/;
const OPENED = /\((?:\.[\\/])?([^\s()]+\.(?:tex|sty|cls))/;

export function parseLatexLog(text: string): LogProblem[] {
	const lines = text.split(/\r?\n/);
	const problems: LogProblem[] = [];
	let currentFile: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const opened = line.match(OPENED);
		if (opened?.[1]) currentFile = opened[1];

		const located = line.match(FILE_LINE);
		if (located) {
			const message = located[3] ?? "";
			problems.push({
				severity: /warning/i.test(message) ? "warning" : "error",
				message,
				file: located[1]?.replace(/^\.[\\/]/, ""),
				line: Number(located[2]),
				logLine: index,
			});
			continue;
		}
		const warning = line.match(WARNING);
		if (warning) {
			const message = (warning[1] || line).trim();
			const inline = message.match(/on input line (\d+)/);
			problems.push({
				severity: "warning",
				message,
				file: currentFile,
				line: inline ? Number(inline[1]) : undefined,
				logLine: index,
			});
			continue;
		}
		if (line.startsWith("! ")) {
			let sourceLine: number | undefined;
			const end = Math.min(index + 8, lines.length);
			for (let next = index + 1; next < end; next++) {
				const marker = lines[next]?.match(/^l\.(\d+)/);
				if (marker) {
					sourceLine = Number(marker[1]);
					break;
				}
			}
			problems.push({
				severity: "error",
				message: line.slice(2).trim(),
				file: currentFile,
				line: sourceLine,
				logLine: index,
			});
			continue;
		}
		const box = line.match(BOX);
		if (box) {
			problems.push({
				severity: "warning",
				message: line.trim(),
				file: currentFile,
				line: Number(box[1]),
				logLine: index,
			});
		}
	}
	return problems;
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:\/)/;

/** TeX prints `d:/…` for a root file at `D:\…`; drive paths ignore case. */
function samePath(a: string, b: string): boolean {
	return /^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Editor path of a problem's file. Relative names resolve against the root
 * file's folder; absolute ones are mapped back onto it. A name outside that
 * folder (`..`, a package from the TeX tree) falls back to the root file.
 */
export function resolveLogProblemPath(
	rootFile: string,
	file: string | undefined,
): string {
	const dir = manuscriptDir(rootFile);
	if (!file) return rootFile;
	const cleaned = file.replace(/^\.[\\/]/, "").replaceAll("\\", "/");
	if (!cleaned || cleaned.includes("..")) return rootFile;
	if (!ABSOLUTE.test(cleaned)) return joinVaultPath(dir, cleaned);
	const path = normalizePath(cleaned);
	if (samePath(path, normalizePath(rootFile))) return rootFile;
	const folder = normalizePath(dir);
	if (
		folder &&
		path[folder.length] === "/" &&
		samePath(path.slice(0, folder.length), folder)
	) {
		return joinVaultPath(dir, path.slice(folder.length + 1));
	}
	return rootFile;
}
