/**
 * Convert bare http(s) URLs in markdown prose into `[domain](url)` inline links.
 *
 * Skips URLs that are already inside Markdown links `[]()` — either the target
 * or the link text — and URLs inside backticks, so agent-written citations and
 * code are not double-wrapped.
 */
export function linkifyBareUrls(text: string): string {
	// 端口号必须留在链接目标里，所以 `(?::\d+)?` 放在主机组之后、路径组之前。
	// 少了它，`http://127.0.0.1:8766/x` 只匹配到主机，`:8766/x` 掉成正文。
	const urlPattern =
		/https?:\/\/[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[-a-zA-Z0-9]+)+(?::\d+)?(?:\/[^`\s)\]>]*)?/g;

	// Walk through the string and only replace URLs that are not inside a
	// markdown link or inline code.
	let out = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null = urlPattern.exec(text);
	const inLinkPattern = /\]\([^)]*$/; // text preceding `](...`
	const inCodePattern = /`[^`]*$/; // inside backticks
	// 方括号按真实配对关系判定：`]` 配最内层的 `[`。
	const brackets = matchSquareBrackets(text);

	while (match !== null) {
		const url = match[0];
		const start = match.index;
		const prefix = text.slice(0, start);
		const insideLink = inLinkPattern.test(prefix);
		// URL 落在链接文字里（`[文字](目标)` 的文字部分）：该位置最内层尚未闭合的
		// `[` 确实被 `](` 收尾。整串原样保留，不做二次包装。
		const insideLabel = isInsideLinkLabel(brackets, text, start);
		const insideCode = inCodePattern.test(prefix);

		if (insideLink || insideLabel || insideCode) {
			out += text.slice(lastIndex, start + url.length);
			lastIndex = start + url.length;
		} else {
			out += text.slice(lastIndex, start);
			const host = safeHostname(url);
			// 解析失败（端口越界等）就保持原文，不做链接化。
			out += host === null ? url : `[${host}](${url})`;
			lastIndex = start + url.length;
		}

		match = urlPattern.exec(text);
	}
	out += text.slice(lastIndex);
	return out;
}

/** 一个方括号及其配对的 `]`（`close` 为 -1 表示没有配对的 `]`）。 */
interface SquareBracket {
	open: number;
	close: number;
}

/**
 * 方括号配对表：`]` 配最内层的 `[`。
 * 未闭合的 `[` 的 `close` 记为 -1；被反斜杠转义的 `\[` / `\]` 是字面量，
 * 不参与配对。
 */
function matchSquareBrackets(text: string): SquareBracket[] {
	const brackets: SquareBracket[] = [];
	const open: number[] = []; // brackets 的下标栈
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if ((ch === "[" || ch === "]") && isEscaped(text, i)) continue;
		if (ch === "[") {
			brackets.push({ open: i, close: -1 });
			open.push(brackets.length - 1);
		} else if (ch === "]") {
			const index = open.pop();
			if (index !== undefined) brackets[index].close = i;
		}
	}
	return brackets;
}

/**
 * 位置 `index` 的方括号是否被反斜杠转义。
 * 连续反斜杠数为奇数时该括号是字面量（CommonMark 规则）。
 */
function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

/**
 * 位置 `pos` 是否落在 Markdown 链接的文字里。
 * 判据：包住该位置的某个 `[`，它的配对 `]` 后面紧跟 `(`。
 * 从最内层往外回溯：外层 label 跨了内层括号时，URL 仍算在 label 里。
 * 没有配对 `]` 的 `[` 不算 link 文字，跨段落的方括号也不会凑成一对。
 */
function isInsideLinkLabel(
	brackets: SquareBracket[],
	text: string,
	pos: number,
): boolean {
	for (let i = brackets.length - 1; i >= 0; i -= 1) {
		const { open, close } = brackets[i];
		if (open >= pos) continue; // 在 pos 之后才打开
		if (close !== -1 && close < pos) continue; // 在 pos 之前已经闭合
		if (close === -1) continue; // 没有配对的 `]`，不是链接文字
		if (text[close + 1] === "(") return true;
	}
	return false;
}

/**
 * 取链接标签用的主机名；URL 解析失败时返回 null。
 * `new URL` 遇到越界端口（如 `:99999`）会抛异常，而链接化在渲染期同步执行，
 * 抛出去会被工作区级 ErrorBoundary 吞成整页错误，所以必须在这里兜住。
 */
function safeHostname(url: string): string | null {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return null;
	}
}

/**
 * Convert bare vault citation paths into Markdown links so they reach the
 * shared citation-pill renderer. These paths commonly occur in agent prose as
 * `Figure 1 (papers/.../paper.pdf#figure=1)`.
 *
 * Only file paths with a supported citation fragment are linked: ordinary
 * relative paths should remain prose, while a citation always has an
 * unambiguous navigation target. As above, existing Markdown links and code
 * spans are left intact.
 */
export function linkifyBareVaultCitations(text: string): string {
	const citationPattern =
		/(^|[("'\s])(papers\/(?:[^\s()[\]`<>,;:!?]+\/)*[^\s()[\]`<>,;:!?]+\.(?:pdf|tex|ltx|md|mdx|markdown)#(?:page|section|figure|table|algorithm|formula|region)=[^\s()[\]`<>,;:!?]+)/gi;

	let out = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null = citationPattern.exec(text);
	const inLinkPattern = /\]\([^)]*$/;
	const inCodePattern = /`[^`]*$/;

	while (match !== null) {
		const prefix = match[1] ?? "";
		const href = match[2] ?? "";
		const hrefStart = match.index + prefix.length;
		const preceding = text.slice(0, hrefStart);

		if (inLinkPattern.test(preceding) || inCodePattern.test(preceding)) {
			out += text.slice(lastIndex, hrefStart + href.length);
			lastIndex = hrefStart + href.length;
		} else {
			out += text.slice(lastIndex, hrefStart);
			// `./` so Streamdown rehype-harden keeps vault-relative hrefs.
			out += `[${citationLabel(href)}](./${href})`;
			lastIndex = hrefStart + href.length;
		}

		match = citationPattern.exec(text);
	}

	out += text.slice(lastIndex);
	return out;
}

function citationLabel(href: string): string {
	const [path, fragment = ""] = href.split("#", 2);
	const base = path?.split("/").filter(Boolean).pop() || href;
	const [key, value] = fragment.split("=", 2);
	if (key === "page" && value) return `${base} · p.${value}`;
	return value ? `${base} · ${key}=${value}` : base;
}
