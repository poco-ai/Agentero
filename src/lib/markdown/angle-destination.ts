/**
 * CommonMark 尖括号 destination（`![alt](<path>)`）的识别。
 *
 * `<` 只有落在链接/图片的 resource 里才是 destination 的起点，所以判定要同时
 * 看三件事：前面是 label 结束 + `(`，label 本身有配对的 `[`，`<` 到 `>` 之间
 * 没有 `<` 或换行，后面收在 `)`（destination 与标题之间要有空格或 tab）。这样
 * 正文里的 `<div>`、`<Constraints>` 不会被误认成 destination。
 *
 * destination 里的 `<` 不是 JSX 标签：`remarkMdx` 不会把 `![a](<my file.png>)`
 * 里的尖括号当标签（image construct 先吃掉了 destination），但 remark 自己会按
 * CommonMark 把它解成 url。
 *
 * 暂不支持的 CommonMark 写法（行为与修复前一致，不算回归）：
 * - 空 destination `![a](<>)`；
 * - `(` 与 `<` 之间换行的 `![a](\n<b.png>)`；
 * - `>` 与 `)` 之间换行的 `![a](<b.png>\n)`（micromark 用
 *   `markdownLineEndingOrSpace`，接受换行；这里只认空格与 tab）。
 */

import { htmlToJsx } from "@platejs/markdown";

/** 一段尖括号 destination：`<` 与 `>` 的下标（含两端）。 */
export type AngleDestination = {
	/** `<` 的下标。 */
	start: number;
	/** `>` 的下标。 */
	end: number;
};

/** destination 里可以转义的三个字符（CommonMark 的 `<`、`>`、`\`）。 */
const ESCAPABLE = "<>\\";

/**
 * 找出 source 里所有尖括号 destination 的区间。
 *
 * `isLiteral` 用来排除已经是字面量的区域（代码块、行内代码、行内公式）：
 * 那里的 `](<...>)` 只是文本，不是 destination。
 */
export function findAngleDestinations(
	source: string,
	isLiteral: (index: number) => boolean,
): AngleDestination[] {
	const found: AngleDestination[] = [];
	// 用 indexOf 跳到下一个 `<`，别逐字符扫：长文档上这是主要开销。
	let i = source.indexOf("<");
	while (i >= 0) {
		if (!isLiteral(i)) {
			const destination = readAngleDestination(source, isLiteral, i);
			if (destination) {
				found.push(destination);
				i = source.indexOf("<", destination.end + 1);
				continue;
			}
		}
		i = source.indexOf("<", i + 1);
	}
	return found;
}

/**
 * 从 `<` 开始读一段 destination，读不出来返回 null。
 *
 * 形状是 `](` + 可选空白 + `<` + 内容 + `>` + 可选标题 + `)`。
 */
function readAngleDestination(
	source: string,
	isLiteral: (index: number) => boolean,
	lt: number,
): AngleDestination | null {
	let paren = lt - 1;
	while (paren >= 0 && (source[paren] === " " || source[paren] === "\t")) {
		paren -= 1;
	}
	if (source[paren] !== "(") return null;
	const closeBracket = paren - 1;
	if (closeBracket < 0 || source[closeBracket] !== "]") return null;
	if (isLiteral(closeBracket) || isLiteral(paren)) return null;
	// label 必须有配对的 `[`，否则 `](<...>)` 只是正文里的字面量。
	if (findLabelOpener(source, isLiteral, closeBracket) < 0) return null;

	let end = lt + 1;
	while (end < source.length) {
		const char = source[end];
		if (char === "\\" && ESCAPABLE.includes(source[end + 1] ?? "")) {
			end += 2;
			continue;
		}
		if (char === ">") break;
		if (char === "<" || char === "\n" || char === "\r") return null;
		end += 1;
	}
	// 空 destination 不是合法的 destination。
	if (source[end] !== ">" || end === lt + 1) return null;
	if (!resourceEndsAt(source, end + 1)) return null;
	return { start: lt, end };
}

/**
 * 往回找 label 的 `[`。找不到说明这个 `]` 不是链接/图片的结束。
 *
 * 只数括号层级，不区分行内代码——代码里的 `[` 会被 `isLiteral` 挡掉。被转义的
 * 括号（`\[`）是字面量，不能当 label 开头。
 */
function findLabelOpener(
	source: string,
	isLiteral: (index: number) => boolean,
	closeBracket: number,
): number {
	let depth = 0;
	for (let i = closeBracket; i >= 0; i -= 1) {
		if (isLiteral(i)) continue;
		const char = source[i];
		if (char === "]") {
			if (isEscapedAt(source, i)) continue;
			depth += 1;
			continue;
		}
		if (char !== "[") continue;
		if (isEscapedAt(source, i)) continue;
		if (depth === 0) return -1;
		depth -= 1;
		if (depth === 0) return i;
	}
	return -1;
}

/** 位置 `index` 的字符前面有奇数个反斜杠时，它是被转义的。 */
function isEscapedAt(source: string, index: number): boolean {
	let backslashes = 0;
	for (let j = index - 1; j >= 0 && source[j] === "\\"; j -= 1) {
		backslashes += 1;
	}
	return backslashes % 2 === 1;
}

/**
 * destination 之后必须收尾：`)`，或者空白 + 标题 + `)`。
 *
 * micromark 的 resource 语法要求 destination 与标题之间有空白
 * （`resourceDestinationAfter` → `resourceBetween`），所以 `![a](<b.png>"t")`
 * 不是一个合法的 resource。
 *
 * 空白这里只认空格与 tab：micromark 用 `markdownLineEndingOrSpace`，也接受换行，
 * 那种写法暂不支持（见文件头）。
 */
function resourceEndsAt(source: string, from: number): boolean {
	let i = from;
	while (i < source.length && (source[i] === " " || source[i] === "\t")) {
		i += 1;
	}
	if (source[i] === ")") return true;
	// 没有空白就不能接标题：整段不是 resource。
	if (i === from) return false;
	if (source[i] === '"' || source[i] === "'") {
		const quote = source[i];
		i += 1;
		while (i < source.length && source[i] !== quote) {
			if (source[i] === "\n" || source[i] === "\r") return false;
			i += 1;
		}
		if (source[i] !== quote) return false;
		i += 1;
	} else if (source[i] === "(") {
		let depth = 0;
		while (i < source.length) {
			const char = source[i];
			if (char === "(") depth += 1;
			else if (char === ")") {
				depth -= 1;
				if (depth === 0) {
					i += 1;
					break;
				}
			} else if (char === "\n" || char === "\r") return false;
			i += 1;
		}
		if (depth !== 0) return false;
	} else {
		return false;
	}
	while (i < source.length && (source[i] === " " || source[i] === "\t")) {
		i += 1;
	}
	return source[i] === ")";
}

/**
 * 把 destination 的首个字符写成实体，Plate 的 `htmlToJsx` 就看不到 `<tag` 了。
 *
 * `htmlToJsx` 会把 `<source/x.png>` 当成 void 标签补成 `<source/x.png />`，把
 * url 改坏。实体化之后 `<` 后面不再是标签名，remark 解析 destination 时会把
 * 实体解码回来，url 不受影响。
 *
 * 只在 `htmlToJsx` 真会改写这段 destination 时才屏蔽：别处本来就不抛错，实体化
 * 反而会让 `<&` 变成非法的 JSX 名，把「不抛错」变成「抛错」。
 */
export function protectAngleDestinations(
	source: string,
	isLiteral: (index: number) => boolean,
): string {
	const destinations = findAngleDestinations(source, isLiteral);
	if (destinations.length === 0) return source;
	let out = "";
	let last = 0;
	for (const { start, end } of destinations) {
		const first = source[start + 1];
		if (first === undefined) continue;
		if (!htmlToJsxRewrites(source.slice(start, end + 1))) continue;
		out += source.slice(last, start + 1);
		out += `&#${first.codePointAt(0) ?? 0};`;
		last = start + 2;
	}
	return last === 0 ? source : out + source.slice(last);
}

/** `htmlToJsx` 会不会改写这段文本（它把 void 标签补成自闭合形式）。 */
function htmlToJsxRewrites(destination: string): boolean {
	return htmlToJsx(destination) !== destination;
}
