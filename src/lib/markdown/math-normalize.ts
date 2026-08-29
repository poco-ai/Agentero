/**
 * Normalize common LaTeX shapes in agent/markdown text so Streamdown + KaTeX
 * (remark-math) can render them.
 *
 * remark-math only sees `$…$` / `$$…$$` (and we enable single-dollar). Models
 * often emit:
 * - bare TeX: `\pi_\theta`
 * - TeX delimiters: `\(...\)` / `\[...\]`
 * - block environments: `\begin{equation}...\end{equation}`
 * without dollar wrapping. Bare `_` also breaks GFM emphasis, so wrapping helps
 * both rendering and layout. KaTeX cannot render `equation` / `multline` /
 * `flalign` wrappers, so those are stripped while the inner math is kept.
 *
 * Blogs (MathJax) additionally rely on page-global macros:
 * - `\newcommand{name}{body}` without the leading backslash KaTeX requires;
 * - a macro defined once (inside the first equation that uses it) and reused
 *   by later equations — KaTeX renders each equation in isolation;
 * - names that collide with KaTeX builtins (`\argmin`, `\argmax`), where
 *   `\newcommand` errors outright;
 * - definitions inside `align` that do not survive `&`/`\\` cell boundaries;
 * - `\label` / `\eqref` cross-references, which KaTeX only supports inside
 *   numbered environments.
 * Definitions are therefore collected document-wide and textually expanded at
 * every use site, statements are dropped, labels are numbered in display order
 * and `\eqref`/`\ref` resolve to those numbers. MathJax-only `\require` and
 * `\cancel` are stripped (degrading to the argument), and older cached markdown
 * whose `$$…$$` blocks were escaped by the HTML→Markdown step is unescaped.
 */

/** Fenced code, inline code, or existing dollar math — leave untouched. */
const PROTECTED =
	/```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$(?:\\\$|[^$\n])+\$/g;

/** `\(…\)` inline and `\[…\]` display (non-greedy, allows nested `\cmd`). */
const TEX_DISPLAY = /\\\[([\s\S]*?)\\\]/g;
const TEX_INLINE = /\\\(([\s\S]*?)\\\)/g;

/** `\begin{env}...\end{env}` block environments (blogs, RSS excerpts). */
const TEX_ENV =
	/\\begin\{(equation\*?|multline\*?|flalign\*?|align\*?|alignat\*?|gather\*?|aligned|eqnarray\*?)\}([\s\S]*?)\\end\{\1\}/g;

/** Environments whose wrappers KaTeX cannot render (inner math is kept). */
const ENV_STRIP_WRAPPERS = /^(equation|multline|flalign)/;

/**
 * Bare command with at least one subscript/superscript, e.g. `\pi_\theta`,
 * `\alpha^{2}`, `x_\mathrm{t}`-style `\\mathrm{t}` scripts.
 */
const BARE_SCRIPTED =
	/(?<![$\\])\\[a-zA-Z]+(?:\{[^{}]*\})*(?:[_^](?:\{[^{}]*\}|\\[a-zA-Z]+(?:\{[^{}]*\})*|[A-Za-z0-9]+))+/g;

/**
 * Bare command with brace args only, e.g. `\frac{a}{b}`, `\mathcal{L}`.
 * Requires at least one `{…}` to avoid wrapping plain `\pi` or `\n`.
 */
const BARE_BRACED = /(?<![$\\])\\[a-zA-Z]+(?:\{[^{}]*\})+/g;

/** Dollar math regions after all transforms: display `$$…$$` or inline `$…$`. */
const MATH_REGION = /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g;

function transformMathRegion(text: string): string {
	if (!text.includes("\\")) return text;

	// Converted regions are stashed behind placeholders so later passes
	// (bare-command wrapping) cannot fragment their insides.
	const stash: string[] = [];
	const keep = (value: string) => {
		stash.push(value);
		return `${stash.length - 1}`;
	};

	let out = text.replace(TEX_ENV, (match, env: string, body: string) =>
		keep(ENV_STRIP_WRAPPERS.test(env) ? `$$${body.trim()}$$` : `$$${match}$$`),
	);
	out = out
		.replace(TEX_DISPLAY, (_m, body: string) => keep(`$$${body}$$`))
		.replace(TEX_INLINE, (_m, body: string) => keep(`$${body}$`));

	out = out.replace(BARE_SCRIPTED, (match) => keep(`$${match}$`));
	out = out.replace(BARE_BRACED, (match) => keep(`$${match}$`));

	return out.replace(/(\d+)/g, (_m, i: string) => stash[Number(i)]);
}

/** Balanced `{…}` group starting at `s[i]`; returns [inner, indexAfter]. */
function readBraced(s: string, i: number): [string, number] | null {
	if (s[i] !== "{") return null;
	let depth = 0;
	for (let j = i; j < s.length; j++) {
		if (s[j] === "\\") {
			j++;
			continue;
		}
		if (s[j] === "{") depth++;
		else if (s[j] === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
	}
	return null;
}

/**
 * Collect `\newcommand` / `\renewcommand` definitions document-wide and drop
 * the statements: uses are expanded textually later, which sidesteps KaTeX's
 * per-equation macro scope, builtin-name collisions and align cell groups.
 * Parameterized bodies (`#1`) cannot be expanded; those statements stay,
 * rewritten to KaTeX's `\newcommand{\name}` form.
 */
function collectNewcommands(source: string): {
	text: string;
	defs: Map<string, string>;
} {
	const defs = new Map<string, string>();
	let out = "";
	let last = 0;
	for (const m of source.matchAll(/\\(re)?newcommand(?![a-zA-Z])/g)) {
		const start = m.index ?? 0;
		let i = start + m[0].length;
		while (/\s/.test(source[i] ?? "")) i++;
		const nameGroup = readBraced(source, i);
		if (!nameGroup) continue;
		const [rawName, afterName] = nameGroup;
		let j = afterName;
		let optional = "";
		if (source[j] === "[") {
			const close = source.indexOf("]", j);
			if (close === -1) continue;
			optional = source.slice(j, close + 1);
			j = close + 1;
		}
		while (/\s/.test(source[j] ?? "")) j++;
		const bodyGroup = readBraced(source, j);
		if (!bodyGroup) continue;
		let [body, afterBody] = bodyGroup;
		const name = rawName.replace(/^\\+/, "");
		if (!/^[a-zA-Z]+$/.test(name)) continue;
		if (body.includes("#")) {
			out +=
				source.slice(last, start) +
				`\\${m[1] ? "re" : ""}newcommand{\\${name}}${optional}{${body}}`;
			last = afterBody;
			continue;
		}
		for (const [prevName, prevBody] of defs) {
			body = body.replace(
				new RegExp(`\\\\${prevName}(?![a-zA-Z])`, "g"),
				() => prevBody,
			);
		}
		if (!defs.has(name)) defs.set(name, body);
		out += source.slice(last, start);
		last = afterBody;
	}
	return { text: out + source.slice(last), defs };
}

/**
 * Older pipelines let bare `$$…$$` blocks run through the HTML→Markdown
 * converter, which markdown-escapes them (`\cmd` → `\\cmd`, `[` → `\[`).
 * Doubled backslashes before a letter mark such regions; unescape them.
 */
function repairEscapedMath(source: string): string {
	return source.replace(MATH_REGION, (region) => {
		if (!region.startsWith("$$") || !/\\\\[a-zA-Z]/.test(region)) return region;
		return region.replace(/\\\\/g, "\\").replace(/\\([[\]_{}#&*+!.|-])/g, "$1");
	});
}

/** MathJax's `\cancel{X}` (and b/xcancel) has no KaTeX core equivalent. */
function dropCancel(s: string): string {
	let out = "";
	let last = 0;
	for (const m of s.matchAll(/\\(b|x)?cancel(?![a-zA-Z])/g)) {
		const start = m.index ?? 0;
		let i = start + m[0].length;
		while (/\s/.test(s[i] ?? "")) i++;
		const group = readBraced(s, i);
		if (!group) continue;
		out += s.slice(last, start) + group[0];
		last = group[1];
	}
	return out + s.slice(last);
}

/** Map each `\label` key to its 1-based display-equation number. */
function numberLabels(result: string): Map<string, number> {
	const labels = new Map<string, number>();
	let n = 0;
	for (const m of result.matchAll(MATH_REGION)) {
		if (!m[0].startsWith("$$")) continue;
		n++;
		for (const lm of m[0].matchAll(/\\label\{([^{}]*)\}/g))
			labels.set(lm[1], n);
	}
	return labels;
}

/**
 * Strip `\label`, resolve `\eqref`/`\ref` to display numbers, and inject
 * document-level macro definitions into regions that use them without a
 * local `\newcommand`.
 */
function rewriteMathRegions(
	result: string,
	defs: Map<string, string>,
	labels: Map<string, number>,
): string {
	return result.replace(
		MATH_REGION,
		(region, offset: number, whole: string) => {
			const display = region.startsWith("$$");
			const delim = display ? "$$" : "$";
			let inner = region.slice(delim.length, region.length - delim.length);
			inner = inner.replace(/\\label\{[^{}]*\}/g, "");
			inner = inner.replace(
				/\\(?:eqref|ref)(?![a-zA-Z])\s*\{([^{}]*)\}/g,
				(_m, key: string) => {
					const n = labels.get(key.trim());
					return n ? `(${n})` : "(?)";
				},
			);
			inner = dropCancel(inner.replace(/\\require\s*\{[^{}]*\}/g, ""));
			for (const [name, body] of defs) {
				inner = inner.replace(
					new RegExp(`\\\\${name}(?![a-zA-Z])`, "g"),
					() => body,
				);
			}
			if (!display) return `${delim}${inner}${delim}`;
			// Fences on their own lines yield flow math (display mode, needed for
			// align); a single-line $$…$$ parses as inline math, which is the only
			// shape that survives mid-sentence (e.g. inside a blockquote line).
			const lineStart = whole.lastIndexOf("\n", offset - 1) + 1;
			const lineEndIdx = whole.indexOf("\n", offset + region.length);
			const lineEnd = lineEndIdx === -1 ? whole.length : lineEndIdx;
			const before = whole.slice(lineStart, offset);
			const after = whole.slice(offset + region.length, lineEnd);
			const prefix = /^(\s*(?:>\s?)+|\s*)/.exec(before)?.[1] ?? "";
			if (before !== prefix || after.trim() !== "") {
				return `$$${inner.trim()}$$`;
			}
			const stripped = inner
				.split("\n")
				.map((line) => line.replace(/^(\s*(?:>\s?)+)+\s*/, ""))
				.join("\n")
				.trim();
			// `before` already carries the prefix on the opening fence line.
			const body = stripped
				.split("\n")
				.map((line) => prefix + line)
				.join("\n");
			return `$$\n${body}\n${prefix}$$`;
		},
	);
}

/** Prepare markdown so KaTeX can render common agent LaTeX forms. */
export function normalizeMarkdownMath(source: string): string {
	if (!source?.includes("\\")) return source;

	// Older cached markdown may still carry KaTeX-unsupported env
	// wrappers inside $$…$$; $$ regions are protected below, so unwrap first.
	const unwrapped = source.replace(
		/\$\$\s*\\begin\{(equation\*?|multline\*?|flalign\*?)\}([\s\S]*?)\\end\{\1\}\s*\$\$/g,
		(_m, _env: string, body: string) => `$$${body.trim()}$$`,
	);

	const { text: fixed, defs } = collectNewcommands(
		repairEscapedMath(unwrapped),
	);

	let result = "";
	let last = 0;
	for (const match of fixed.matchAll(PROTECTED)) {
		const start = match.index ?? 0;
		if (start > last) {
			result += transformMathRegion(fixed.slice(last, start));
		}
		result += match[0];
		last = start + match[0].length;
	}
	if (last < fixed.length) {
		result += transformMathRegion(fixed.slice(last));
	}

	return rewriteMathRegions(result, defs, numberLabels(result));
}
