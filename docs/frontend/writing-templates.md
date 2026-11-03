# 写作模板

新建写作项目时可以选空白项目或会议模板。会议模板是各会议公开的作者包，原样存放在 `src/lib/writing/templates/vendor/<id>/`，应用不改官方文件，也不向其中写入标题或作者。来源记录在同目录的 `SOURCES.md`。

## 模板清单

| id | 显示名 | 主文件 | 来源 |
|---|---|---|---|
| `blank` | 空白 | `main.tex`（应用生成） | — |
| `cvpr` | CVPR / ICCV | `main.tex` | [cvpr-org/author-kit](https://github.com/cvpr-org/author-kit) |
| `icml` | ICML | `example_paper.tex` | 官方 `icml2026.zip` |
| `iclr` | ICLR | `iclr2027_conference.tex` | ICLR 2027 官方样式文件 |
| `neurips` | NeurIPS | `neurips_2026.tex` | NeurIPS 2026 官方格式说明包 |
| `acl` | ACL / EMNLP | `acl_latex.tex` | [acl-org/acl-style-files](https://github.com/acl-org/acl-style-files) |
| `eccv` | ECCV | `main.tex` | ECCV 2026 官方 LNCS 模板 |

空白项目的 `main.tex` 由 `writingTemplateFiles("blank", 项目名)` 生成：`article` 文档类，项目名写进 `\title`，其中的 `\ & % $ # _ { }` 会转义；文件里不写 `% !TEX program`。

## 打包

`src/lib/writing/templates/index.ts` 在构建时用 `import.meta.glob` 收集 vendor 文件：

- 文本文件：`./vendor/*/**/*.{tex,sty,bst,bib,cls,clo,eps}`，`?raw` + `eager`，内容直接打进前端 bundle。
- PDF：`./vendor/*/**/*.pdf`，`?url` + `eager`，作为静态资源发布，新建项目时再 `fetch` 回来写入。

不匹配这两条 glob 的文件不会打包，新建的项目里也就没有它们。

## 新建项目

1. 新建项目面板（`src/components/writing/new-project-form.tsx`）按 `WRITING_TEMPLATE_IDS` 的顺序列出模板，显示名取 `src/i18n/locales/{en,zh-CN}/sidebar.json` 里的 `writing.templates.<id>`。
2. `createWritingProject`（`src/lib/writing/projects.ts`）检查项目名，在 `thesis/<项目名>/` 下创建项目，目录或主文件已存在时不创建。先写入 `writingTemplateFiles` 返回的文本文件（保持官方包里的相对路径），再写入 `writingTemplateAssets` 返回的 PDF，然后刷新文件树，返回主文件路径。
3. 面板以文本模式打开这个主文件。

## 主文件与编译引擎

`ROOTS` 只决定新建后打开哪个文件，不会记到项目里。之后按通用规则识别：

- 项目主文件：`src/lib/writing/discover.ts` 的 `findTexRoot` 在项目目录顶层的 `.tex` 里依次选 `main.tex`、`thesis.tex`、和目录同名的文件，都没有时按路径排序取第一个；顶层没有 `.tex` 时再看一层子目录。
- 编译根：编译、预览和 SyncTeX 用 `resolveTexRoot`。项目设置里显式选了主文件时用它；否则依次看 `% !TEX root`、文件自身的 `\documentclass` / `\begin{document}`、知识库里 `\input` / `\include` 了它的文件，都没有时用文件本身（详见 [LaTeX](latex.md)）。

现有模板的编译根都会落到 `ROOTS` 写的文件上。CVPR 和 ECCV 的主文件就叫 `main.tex`；ICML 顶层只有一个 `.tex`；ICLR 的 `math_commands.tex`、ACL 的 `acl_lualatex.tex` 按路径排在主文件后面。NeurIPS 的 `checklist.tex` 排在 `neurips_2026.tex` 前面，会先被 `findTexRoot` 选中，但它没有 `\documentclass`，由 `neurips_2026.tex` `\input`，`resolveTexRoot` 会解析回 `neurips_2026.tex`。

引擎的选择顺序见 [LaTeX](latex.md)。和模板有关的是 `src/lib/tex/engine.ts` 的 `inferRequiredEngine`，它只看主文件的导言区（`\begin{document}` 之前，去掉注释）：

- `\babelfont` / `\babelprovide` 要求 LuaLaTeX，例如 ACL 包里的 `acl_lualatex.tex`。
- `fontspec`、`polyglossia`、`xeCJK` 或 `ctex` 系列文档类要求 XeLaTeX。
- `\usepackage` 或 `\documentclass` 用到 `CONFERENCE_ENGINE` 里的名字时要求 pdfLaTeX：`cvpr`、`iccv`、`iclr`、`icml`、`neurips`、`acl`、`eccv`、`eccvabbrv`、`llncs`。其中 `iclr`、`icml`、`neurips` 可以带年份，如 `iclr2027_conference`、`icml2026`、`neurips_2026`。

都不匹配，也没有 `% !TEX program` 和记住的选择时，用 XeLaTeX（没装时用第一个可用引擎）。

## 测试

- `test/writing-templates.test.ts`：空白项目只生成 `main.tex`，标题转义，不写 `% !TEX program`；ICML、ACL 的主文件名，CVPR 主文件里的 `\usepackage[review]{cvpr}`，以及 `cvpr.sty`、`sec/1_intro.tex`、`icml2026.sty`、`iclr2027_conference.sty`、`neurips_2026.sty`、`acl.sty`、`llncs.cls` 都在。
- `test/tex-engine.test.ts`：CVPR、ICLR、ECCV（`llncs`）、NeurIPS、ICML 的包要求 pdfLaTeX，注释掉的 `\usepackage{cvpr}` 不算；`\babelfont`、`fontspec`、`ctexart` 对应的引擎。

## 新增会议模板

以 `<venue>` 为例：

1. **放官方包**：把官方作者包解压到 `vendor/<venue>/`，保留目录结构，不改官方文件。编译好的示例 PDF、说明文档这类用不到的文件可以不放，ICML 和 ECCV 就是这样。在 `vendor/SOURCES.md` 加一行，写明来源和主文件。
2. **注册**：在 `index.ts` 里把 `"<venue>"` 加进 `WRITING_TEMPLATE_IDS`（下拉按这个顺序），并在 `ROOTS` 里填主文件在包内的路径。`ROOTS` 的类型要求每个会议模板都有主文件，漏填时 typecheck 会报错。
3. **核对文件类型**：包里有扩展名不在 `tex,sty,bst,bib,cls,clo,eps` 里的文本文件（如 `.def`、`.cfg`、`.fd`）时，加进文本 glob；有 PDF 以外的二进制文件（如 `.png`、`.jpg`）时，加进 PDF 那条 `?url` glob。否则新建的项目会缺文件。
4. **核对主文件识别**：主文件不叫 `main.tex` 时，确认顶层按路径排在它前面的 `.tex` 都不是独立文档（自己带 `\documentclass`）。否则 `findTexRoot` 会选中那个文件，编译根也会停在它上面。
5. **显示名**：在 `en` 和 `zh-CN` 的 `sidebar.json` 里加 `writing.templates.<venue>`。
6. **引擎**：确认主文件的导言区能被 `inferRequiredEngine` 认出来。类名或宏包名不在 `CONFERENCE_ENGINE` 里时，把它加进去，否则会按 XeLaTeX 编译。
7. **测试**：在 `test/writing-templates.test.ts` 断言主文件名和关键样式文件；改了 `CONFERENCE_ENGINE` 时，在 `test/tex-engine.test.ts` 加一条断言。
8. **文档**：更新本页的模板清单，以及 [写作](writing.md) 里列出的会议名。
9. **验证**：`pnpm typecheck`、`pnpm lint:ts`、`pnpm vitest run test/writing-templates.test.ts test/tex-engine.test.ts`；再在应用里用这个模板新建项目，确认文件齐全、能直接编译。

## 已知限制

- vendor 文本文件全部 eager 打进前端 bundle，模板越多，bundle 越大。
- 模板信息分散在 `WRITING_TEMPLATE_IDS`、`ROOTS`、两份 `sidebar.json`、`CONFERENCE_ENGINE` 和测试里，新增时要逐处改（见上面的步骤）。
- 官方包原样复制。换成新一年的包时要整体替换目录，并同步 `ROOTS`、`SOURCES.md` 和测试里带年份的文件名；`CONFERENCE_ENGINE` 已允许 `iclr`、`icml`、`neurips` 带年份，命名方式不变时不用改。应用不会在运行时下载或更新模板。
- 写入中途失败时不回滚：已经写入的文件留在 `thesis/<项目名>/`，再用同一个名字新建会提示已存在。
