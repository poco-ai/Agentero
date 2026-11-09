# 全文译文划选：按句锚回原文

> 状态：已落地，字符级重排路径也保留句对。现行行为见 [../frontend/translate.md](../frontend/translate.md) 与 [../frontend/wiki.md](../frontend/wiki.md)。下面是当时的问题与方案，文中的「现在」指落地前。
>
> 和初稿有四处差别。`。` `！` `？` 后面没有空格也切句。一句跨框时仍用 `splitChainTranslation`，按这句原文在各 member 里的长度切开，下一句不再切进前一个框。侧栏译文面板不挂批注，英文高亮的淡底只画在主阅读器。翻译前的英文高亮按字形框重叠铺到对应句，不按文字片段去套同页的每一句。

默认重排路径按句翻译、按段排版。排版后的选区层保留句界，原文矩形按句截取 PDF 字形；若选中的任一句定位失败，本次选区仍可复制和发起对话。需要句对的旧重排缓存会在主阅读器再次发起翻译时按块更新。

## 1. 一句话

在全文译文上划中半句，批注锚的是这句对应的整句英文；划过连续几句，锚的就是这几句。不落到字词，也不扩成整个版面块。

英文文字层上的划选保持现在的字形精度，不改成整句吸附。

## 2. 现在为什么对不回去

全文翻译一块版面只存一条 `source` 和一条 `translated`（`{paper}/source/layout-translate.json`，`schemaVersion` 1）。`[[n]]` 的编号单位是版面块或 chain，不是句子。默认提示词允许调整语序、拆开长句（`src/lib/translate/prompt.ts`）。

译文 `<p>` 能被浏览器选中，但这条选区不进 EmbedPDF，不会打开划词菜单，也不会写 `annotations.json`。高亮、备注、快速对话、加入对话的 `quote` 和矩形都来自 PDF 文字层；`comment` 只放用户自己写的话。

跨栏、跨页的 chain 先拼成一条再翻译，然后按各片段原文长度把译文切回各自的框（`splitChainTranslation`）。切点可以落在两句之间，框里的译文和该框英文并不成对。选区发生之后再拿中文片段去整段英文里比对，会对到别的句子上。

## 3. 要做

- 翻译前把一块（或一条 chain）的英文按句切开，每句一个 `[[n]]`，沿用 `buildTranslateBatches`。
- 每句留下 `{ quote, source, translated }`。`quote` 是文字层原串，`source` 是送进引擎的归一化串，`translated` 是这句的译文。
- 覆盖层仍拼成一段画出。每句译文包在一个 `<span>` 里，划选按 span 下标找到句对。
- 高亮、备注、快速对话、加入对话写入现有批注：`quote` 用这些句子的英文原串，矩形用 PDFium 在文字层里定位这句得到的字形框。
- 半句 → 这一整句；连续几句 → 这几句的并集。
- 句对缺失时（旧缓存、这一块重译还没完成），划选退回该块整段英文，不猜句子。
- 已有英文高亮与新批注使用和划词浅黄底相同的叠放：译文纸面在下，高亮在中，译文字形在上。
- 笔记里的批注嵌入块在对得上句对时，原文下面用更弱颜色显示这几句的译文，字号与原文相同。对不上只显示原文。

## 4. 不做

- 字词对齐，或按译文 DOM 矩形反查底下的英文字形。
- 把划中的译文写进 `quote`、`comment` 或 `annotations.json`。
- 另存一套中文批注。
- 引用比整块短时，把整段块译文塞进嵌入块。
- 在侧栏译文面板上新建批注，或把滚动同步从页面比例改成句子对齐。
- 视觉批注。它锚的是页面区域，与语言无关。
- 在英文文字层上把任意划选吸附成整句。

## 5. 句对怎么产生

切句发生在 `normalizeLayoutSourceText` 之前，切的是 `region.text`。chain 先按现在的规则拼接，再切句。被分栏或分页切开的一句英文仍然是一个编号。

`quote` 用这一刀切出来的原串，不做行末连字符合并。送入引擎的 `source` 仍走现有归一化。定位和 `agentero mark add` 都用 `quote`，避免「representation」对不上文字层里的 `repre- sentation`。

句末：拉丁 `.` `!` `?` 要后面有空白或已经到结尾；`。` `！` `？` 单独即可切句。`et al.`、`Fig.`、`e.g.`、`i.e.`、小数（`0.5`）不当句末。切分单独做纯函数，用这些例子做测试。

编号和回切复用 `[[n]]`：

- 应用追加的批量规则写明：不跨编号搬动内容，不合并编号，不丢编号。句内可以调整语序，也可以把一句英文写成两句译文。
- 自定义提示词只替换学术风格块（一行短口语则只作附加偏好）。引擎规则和批量规则由应用写进 system。`buildTranslateMessages` 与 Host `openai_translate_messages` 一起改。
- 内置 Hunyuan 不吃 `[[n]]`，Host 已按段逐条请求。这里的段改成一句。
- 标记解析失败时，该批退回逐句重译。某一句仍然失败，这一块不写 `sentences`，划选退回整段英文。

画回各框时，只把这一句译文按该句原文在各 member 里的长度分进去。一句跨多个 member 时仍用 `splitChainTranslation`，权重是各 member 里这段原文的字符数。下一句的译文不切进这个框。任一 member 里划中这句译文，`quote` 都是这一整句英文。

## 6. 落盘

`LayoutTranslateSidecarItem` 增加：

```ts
sentences?: {
  /** 文字层原串，批注 quote 用这份 */
  quote: string;
  /** 归一化后送进引擎的串 */
  source: string;
  translated: string;
}[];
```

块上的 `source` / `translated` 仍是拼好的整段，覆盖层和缓存校验继续用它们。`LAYOUT_TRANSLATE_SIDECAR_SCHEMA_VERSION` 从 1 升到 2。版本不对的文件整份视为未命中，按块重译。重译完成前，这块上的划选走整段英文。

覆盖层在现有 `<p>` 里为每句放一个 `<span data-sentence="i">`。目标语言分句需要空格时才插入空格，中文拼接不加空格。复制拿到的是可见译文。

## 7. 划选怎么变成批注

选区的锚点落在译文 span 上时走这条路径。落在 PDF 文字层上时保持今天的 EmbedPDF 选区。

| 操作 | 结果 |
|---|---|
| 复制 | 复制译文，不建批注 |
| 高亮 / 备注 | `quote` 为覆盖到的英文原句；矩形为这些句子在文字层中的字形框。备注正文只进 `comment` |
| 快速对话 / 加入对话 | 选区文本是英文原句。全文译文开着时，把配对的 `translated` 作为额外上下文交给模型，不替换英文 |
| 翻译 | 不把中文再送去翻译。这句译文已经在句对里 |

一句跨页时，按页各写一条高亮，与现在 `createHighlights` 一页一条一致。每条的矩形只含该页上的字形，`quote` 仍是整句。

`quote` 在文字层里搜不到时，仍保存这句英文，矩形退回该句所在版面块里的文字层字形。不丢句子。

没有 `sentences` 的块：锚整段英文 `source`，矩形用该块 bbox 内的文字层字形。

## 8. 阅读译文时怎么看见

高亮矩形是英文的字形框，和中文行对不齐。阅读译文时，用高亮 `quote` 对照 `sentences[].quote`，给对应的译文 span 加淡底。淡底是画的时候算的，不写进 `annotations.json`。

纸面、高亮、字形的叠放与划词浅黄底相同：纸面在下，高亮在中，字形在上。关掉译文后，高亮仍在英文上。

侧栏译文面板继续不挂批注插件。滚动仍按页面比例。

## 9. 批注嵌入块

全文译文已经落在 `{paper}/source/layout-translate.json`：现在是一块一条整段 `source` / `translated`。划词翻译另存在 `marks/<id>.json`（`kind: translate`），`quote` 是划中的英文，`result` 是这一段的译文。笔记里的批注嵌入（`![[papers/…/NOTES@id]]`，`src/components/editor/embeds/wiki-annotation-embed.tsx`）只读高亮的 `quote`，不读这两份译文。

句对落地之后，嵌入块按批注的英文 `quote` 去对，对上才在原文下面画出译文：

- 原文保持引用样式。译文紧挨在下面，字号与原文相同，颜色更弱。不加「译文」标签。
- 对 `layout-translate.json` 的 `sentences[].quote`。批注的 `quote` 等于一句，或等于连续几句按原文拼接的结果，就显示这些句子的 `translated`，顺序与句子一致。
- 对不上句对时，不拿整段 `translated` 来凑。schema 1 的整段译文只在 `source` 与批注 `quote` 完全相同才显示。
- 划词翻译记录里已有和这条 `quote` 相同的 `result` 时，用它作为同一层译文。两处都有时优先句对；句对没有再用划词翻译的 `result`。
- 译文是画的时候读文件算出来的，不写回批注。文件里的译文随缓存更新后，嵌入块跟着变。没有译文文件、或这句还没有译文，嵌入块保持现在的样子。
- 视觉批注没有英文句对，不参与这层。

## 10. 验收

- 译文里划半句再高亮：`quote` 是整句英文，矩形盖住这句英文，不盖住同块的其他句子。
- 默认重排模式划过连续两句并写批注：`quote` 和原文矩形都只覆盖这两句；批注正文保存在 `comment`。
- 选中的句子有句对但无法定位原文字形时，仍可复制和发起对话，不写入范围不全的标记。
- 从译文选区添加书签，默认标题是对应英文。
- 复制只得到译文，磁盘上不新增批注。
- 模型合并了 `[[n]]` 时退回逐句重译，最终每句仍有一对。
- `et al.`、`Fig. 1`、`0.5` 不被切成两句。
- schema 1 的缓存不当成句对；重译后是 schema 2。
- 分栏切断的一句，左右两框划选得到同一句英文。
- 关掉译文后，高亮仍标在英文上。`agentero mark add` 用这条 `quote` 能定位到同一句。
- 嵌入块的 `quote` 等于一句或连续几句时，原文下面出现对应译文，字号与原文相同、颜色更弱，批注文件本身不变。
- 嵌入块的 `quote` 只是块中的一部分、且没有句对时，不显示整段块译文。
- 删掉或尚未生成 `layout-translate.json` 时，嵌入块只显示原文。

## 11. 指针

- [翻译](../frontend/translate.md)
- [双链](../frontend/wiki.md)
- [PDF 阅读器](../frontend/pdf.md)
- `src/components/editor/embeds/wiki-annotation-embed.tsx`
- `src/lib/pdf/annotation-ref.ts`
- `src/lib/pdf/layout/layout-translate.ts`
- `src/lib/pdf/layout/layout-translate-source.ts`
- `src/lib/pdf/layout/layout-translate-reliable.ts`
- `src/components/viewer/pdf/layers/layout-translate-overlay.tsx`
- `src/lib/pdf/layout/layout-sentences.ts`
- `src/lib/pdf/layout/annotation-translate-display.ts`
- `src/lib/translate/prompt.ts`
- `src/lib/pdf/highlight/types.ts`
- `src/components/viewer/pdf/hooks/use-pdf-text-selection.ts`
- `src/components/viewer/pdf/hooks/use-pdf-selection-actions.ts`
