# Agentero CLI 完整帮助（设计稿）

以下每节就是对应层级的终端帮助预览。示例中的库、论文、版本和请求 ID 为演示值。中文为评审语言，正式帮助随 locale 选择。

## `agentero --help`

```text
agentero · 本地科研工作台

用法
  agentero <command> [options]

示例
  agentero paper list --state unread
  agentero search "batch size" --in papers/atlas
  agentero read papers/atlas --page 8

命令
  search        在指定材料或整个 Vault 内查找可引用的出处
  read          按引用、论文或文件读取有位置的原文
  paper         管理题录、导入导出、论文资产与引用关系
  file          浏览与整理 Vault 内的文件、论文目录和回收站
  annotation    在论文原文上创建和维护批注
  table         查询研究表，按记录 ID 写行或改单元格
  feed          管理订阅和订阅条目的阅读状态
  translate     翻译一段文本或 stdin 内容
  vault         创建、选择、检查或修复本地研究库
  sync          配置并运行 Vault 同步
  app           打开桌面视图、安排分栏、展示回合产物
  delegate      向已连接的远端研究工作区提交任务
  mcp           为外部客户端运行或检查工具服务
  help          查看任意命令的帮助或结构化定义

全局选项
  -h, --help              查看此级帮助
  --version               打印版本并退出
  --vault VAULT           指定 Vault ID 或本机根目录
  --json                  输出结构化 JSON
  --no-input              禁止交互提问
  --quiet                 隐藏进度
  --color auto|always|never  终端着色（默认 auto）

文档  https://agentero-docs.poco-ai.com
反馈  https://github.com/poco-ai/Agentero/issues
```

## `agentero search --help`

```text
在指定材料或整个 Vault 内查找可引用的出处

用法
  agentero search QUERY [options]

示例
  agentero search "batch size" --in papers/atlas --kind body

参数与选项
  QUERY    检索词或短语。非空文本；必填
  --in    只在指定论文、文件或目录内查找。论文 ID、Vault 相对路径或不透明 cite 引用，可重复；可选
  --plain    每行输出一个可传给 read 的 cite；与 --json 互斥。
  --kind    匹配的材料类别。metadata | body | note | file | table，可重复；可选
  --tag    标签筛选。非空标签名，可重复；可选
  --match    多个词的匹配策略。all | any；可选；默认 all
  --limit    本次返回的最大条目数。整数 1…50；可选；默认 20
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  --in 多项取并集，--kind 取并集，--tag 取交集且仅匹配所属论文。按相关度、来源 ID、位置稳定排序；题录、正文、笔记、表格单元格和 UTF-8 文件均给出处。

结果
  Sources · items, next_cursor

全局选项见 agentero --help。
```

## `agentero read --help`

```text
按引用、论文或文件读取有位置的原文

用法
  agentero read SOURCE [options]

示例
  agentero read papers/atlas --page 8
  agentero search "batch size" --limit 1 --plain | agentero read -

参数与选项
  SOURCE    论文 ID、Vault 相对路径或命中的 cite。传 - 从 stdin 读取一个来源标识。
  --part    读取论文的哪个部分或呈现形式。auto | body | notes | metadata | layout；可选；默认 auto
  --page    物理页从 1 起，例 8 或 1-3,7。去重后最多 200 页，按页序输出。
  --section    章节标题或稳定章节标识；同名时报候选。非空文本；可选
  --region    版面索引的区域 ID 或锚点。前序命令返回的标识符；可选
  --quote    要定位的原句；存在歧义时返回候选引用。非空文本；可选
  --lines    文本行，从 1 起，含两端。1 起闭区间，例 12-24；可选
  --max-chars    本次正文最多返回的 Unicode 字符数。整数 1…20000；可选；默认 4000
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  page、section、region、quote、lines 互斥。part=layout 需要单页或一个 region。多页正文保留分页，lines 用于文本。引用自带定位，禁止再传定位器。无定位时，论文给摘要与可读入口，文本文件从首行开始，目录返回子项。body 优先 TeX、PAPER.md、版面，再尝试 PDF 文本；指定页和区域只用有对应坐标的源。原生 PDF 有文本层即可按页读。长内容带续读游标。

结果
  Passage · source, revision, text, evidence, entries, regions, metadata, next_cursor, truncated

全局选项见 agentero --help。
```

## `agentero paper --help`

```text
agentero paper · 管理题录、导入导出、论文资产与引用关系

用法
  agentero paper <command> [options]

命令
  list          按题录筛选馆藏论文
  get           查看一篇论文的元数据、资产与路径
  import        从外部材料建立论文记录
  discover      从 arXiv 检索和排序候选论文
  export        将选中的题录导出为参考文献
  update        修改题录字段或阅读状态
  tag           查看标签词表或编辑一篇论文的标签
  note          编辑论文的关联笔记，读取用 read --part notes
  relations     查看论文的参考文献及被引关系
  regions       列出可直接读取的图、表、公式与文本区域
  download      为已收录论文补齐来源文件
  extract       将 PDF 文本提取成可搜索的正文
  analyze       生成 PDF 的页、图表与段落索引
  link          将同一篇论文列入本库另一个论文目录
  copy          将论文复制到另一个 Vault

示例
  agentero paper list --state unread
  agentero paper import id 1706.03762
  agentero paper relations papers/atlas

全局选项见 agentero --help。
```

## `agentero paper list --help`

```text
按题录筛选馆藏论文

用法
  agentero paper list [options]

示例
  agentero paper list --tag survey --state unread

参数与选项
  --plain    每行输出一个论文 ID；与 --json 互斥。
  --query    在题录中查找的文本。非空文本；可选
  --tag    标签筛选。非空标签名，可重复；可选
  --state    阅读状态。read | unread；可选
  --status    题录的自定义状态。非空文本；可选
  --include-internal    包括系统生成的标签。默认关闭
  --sort    题录排序字段。updated | title | date；可选；默认 updated
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  query 匹配题名、作者、标识或路径；多个 tag 全部满足。updated/date 降序，title 升序，同值按 ID。

结果
  Papers · items, next_cursor

全局选项见 agentero --help。
```

## `agentero paper get --help`

```text
查看一篇论文的元数据、资产与路径

用法
  agentero paper get PAPER [--include-internal]

示例
  agentero paper get papers/atlas

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --include-internal    包括系统生成的标签。默认关闭

行为
  返回 DOI、arXiv ID、作者、状态、标签和实际存在的 PDF、TeX、正文、笔记、批注位置，路径相对 Vault。

结果
  PaperDetail · id, path, title, state, tags, revision, authors, venue, date, doi, arxiv, status, abstract, assets

全局选项见 agentero --help。
```

## `agentero paper import --help`

```text
agentero paper import · 从外部材料建立论文记录

用法
  agentero paper import <command> [options]

命令
  id            从 DOI、arXiv 标识或论文 URL 入库
  pdf           从一份或多份本地 PDF 入库
  bib           从本地参考文献文件或 stdin 批量入库

示例
  agentero paper import id 1706.03762

全局选项见 agentero --help。
```

## `agentero paper import id --help`

```text
从 DOI、arXiv 标识或论文 URL 入库

用法
  agentero paper import id IDENTIFIER [--into INTO]

示例
  agentero paper import id 1706.03762

参数与选项
  IDENTIFIER    需要入库的 DOI、arXiv ID 或论文 URL。DOI、arXiv ID 或论文 URL；必填
  --into    目标论文父目录。Vault 相对目录；可选；默认 papers

行为
  按规范化标识去重，已收录返回 existing；书目信息和可取得的资产分别报告。

结果
  Import · items

全局选项见 agentero --help。
```

## `agentero paper import pdf --help`

```text
从一份或多份本地 PDF 入库

用法
  agentero paper import pdf INPUTS… [--into INTO] [--no-recognize] [--analyze]

示例
  agentero paper import pdf "./papers to import/a.pdf" b.pdf

参数与选项
  INPUTS    一个或多个本机 PDF 路径。本机文件系统路径，可给多项；必填
  --into    目标论文父目录。Vault 相对目录；可选；默认 papers
  --no-recognize    跳过 PDF 题录识别。默认关闭
  --analyze    入库后生成版面索引。默认关闭

行为
  按文件报告。默认识别题录，--no-recognize 可跳过；analyze 在入库后做版面分析，失败可针对已入库的论文重做。

结果
  Import · items

全局选项见 agentero --help。
```

## `agentero paper import bib --help`

```text
从本地参考文献文件或 stdin 批量入库

用法
  agentero paper import bib INPUT [--format FORMAT] [--into INTO]

示例
  agentero paper import bib - < library.bib

参数与选项
  INPUT    输入文件，- 表示标准输入。本机输入文件或 -（stdin）；必填
  --format    参考文献格式。auto | bibtex | biblatex | ris；可选；默认 auto
  --into    目标论文父目录。Vault 相对目录；可选；默认 papers

行为
  input=- 读 stdin。逐条返回创建、重复或错误，自动识别失败提示显式指定 format。

结果
  Import · items

全局选项见 agentero --help。
```

## `agentero paper discover --help`

```text
从 arXiv 检索和排序候选论文

用法
  agentero paper discover [options]

示例
  agentero paper discover --category cs.CL --keyword retrieval

参数与选项
  --keyword    主题检索词，可重复。非空文本，可重复；可选
  --category    arXiv 学科分类，可重复。非空文本，可重复；可选
  --match    多个词的匹配策略。all | any；可选；默认 all
  --since    最早提交日期，含当天。YYYY-MM-DD；可选
  --until    最晚提交日期，含当天。YYYY-MM-DD；可选
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 20
  --candidates    排序前最多取多少候选。整数 1…2000；可选；默认 100
  --include-known    保留已经入库的候选。默认关闭
  --rank    词法排序或混合语义排序。lexical | hybrid；可选；默认 lexical
  --embedding-profile    本机预配置的嵌入服务与模型。前序命令返回的标识符；可选
  --semantic-weight    语义相似度的加权系数，仅 hybrid 使用。数值 0…10；可选；默认 1

行为
  至少一个 keyword 或 category。since≤until，limit≤candidates。hybrid 需要本机配置的 embedding profile；只有已选 Vault 时才去除馆藏项。只查询，不入库。

结果
  Candidates · items

全局选项见 agentero --help。
```

## `agentero paper export --help`

```text
将选中的题录导出为参考文献

用法
  agentero paper export [--paper PAPER…] [--tag TAG…] [--format FORMAT] [--output OUTPUT]

示例
  agentero paper export --tag survey --format bibtex > survey.bib

参数与选项
  --paper    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录，可重复；可选
  --tag    标签筛选。非空标签名，可重复；可选
  --format    参考文献格式。bibtex | biblatex | ris；可选；默认 bibtex
  --output    导出目的地，- 表示标准输出。本机输出文件或 -（stdout）；可选；默认 -

行为
  不指定筛选导出全库；论文集合与标签筛选取交集。默认写 stdout；已有目标文件报冲突。

结果
  Export · format, content, path, count

全局选项见 agentero --help。
```

## `agentero paper update --help`

```text
修改题录字段或阅读状态

用法
  agentero paper update PAPER --if-revision IF-REVISION [options]

示例
  agentero paper update papers/atlas --state read --if-revision r7

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --title    显示名称或题名。非空文本；可选
  --author    作者全名，按顺序重复传入。非空文本，可重复；可选
  --venue    期刊、会议或出版物。非空文本；可选
  --date    发表日期，可仅含年份或年月。YYYY、YYYY-MM 或 YYYY-MM-DD；可选
  --doi    DOI。非空文本；可选
  --arxiv    arXiv 标识。非空文本；可选
  --state    阅读状态。read | unread；可选
  --status    题录的自定义状态。非空文本；可选
  --clear    显式清空指定字段或用户标签集合。authors | venue | date | doi | arxiv | status，可重复；可选
  --if-revision    提交所依据的版本，来自该对象的读取结果。上次读取所得不透明版本；必填

行为
  至少一项修改。author 按输入顺序整体替换；clear 显式清空可空字段，与同字段赋值互斥。title 不可清空。

结果
  PaperDetail · id, path, title, state, tags, revision, authors, venue, date, doi, arxiv, status, abstract, assets

全局选项见 agentero --help。
```

## `agentero paper tag --help`

```text
agentero paper tag · 查看标签词表或编辑一篇论文的标签

用法
  agentero paper tag <command> [options]

命令
  list          查看全库标签及论文数量
  add           给论文增加标签
  remove        移除指定标签
  set           整体替换论文标签

示例
  agentero paper tag list

全局选项见 agentero --help。
```

## `agentero paper tag list --help`

```text
查看全库标签及论文数量

用法
  agentero paper tag list [--include-internal] [--limit LIMIT] [--cursor CURSOR]

示例
  agentero paper tag list

参数与选项
  --include-internal    包括系统生成的标签。默认关闭
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  按使用数降序、名称升序。

结果
  Tags · items, next_cursor

全局选项见 agentero --help。
```

## `agentero paper tag add --help`

```text
给论文增加标签

用法
  agentero paper tag add PAPER TAGS…

示例
  agentero paper tag add papers/atlas survey retrieval

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  TAGS    标签名，多个用空格分隔。非空标签名，可给多项；必填

行为
  忽略大小写去重；允许 name:color，颜色写入标签元数据。

结果
  PaperDetail · id, path, title, state, tags, revision, authors, venue, date, doi, arxiv, status, abstract, assets

全局选项见 agentero --help。
```

## `agentero paper tag remove --help`

```text
移除指定标签

用法
  agentero paper tag remove PAPER TAGS…

示例
  agentero paper tag remove papers/atlas survey

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  TAGS    标签名，多个用空格分隔。非空标签名，可给多项；必填

行为
  按名称移除，重复调用返回当前集合。

结果
  PaperDetail · id, path, title, state, tags, revision, authors, venue, date, doi, arxiv, status, abstract, assets

全局选项见 agentero --help。
```

## `agentero paper tag set --help`

```text
整体替换论文标签

用法
  agentero paper tag set PAPER [TAGS…] [--clear] --if-revision IF-REVISION

示例
  agentero paper tag set papers/atlas --clear --if-revision r7

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  TAGS    标签名，多个用空格分隔。非空标签名，可给多项；可选
  --clear    显式清空指定字段或用户标签集合。默认关闭
  --if-revision    提交所依据的版本，来自该对象的读取结果。上次读取所得不透明版本；必填

行为
  提供非空标签或 --clear，二选一；只操作用户标签。

结果
  PaperDetail · id, path, title, state, tags, revision, authors, venue, date, doi, arxiv, status, abstract, assets

全局选项见 agentero --help。
```

## `agentero paper note --help`

```text
agentero paper note · 编辑论文的关联笔记，读取用 read --part notes

用法
  agentero paper note <command> [options]

命令
  append        在论文笔记末尾追加 Markdown
  replace       用 Markdown 替换整篇论文笔记
  fetch         获取外部论文解读并追加为带来源的笔记

示例
  agentero read papers/atlas --part notes
  agentero paper note append papers/atlas --input notes.md --request-id note-17

全局选项见 agentero --help。
```

## `agentero paper note append --help`

```text
在论文笔记末尾追加 Markdown

用法
  agentero paper note append PAPER --input INPUT [--request-id REQUEST-ID]

示例
  agentero paper note append papers/atlas --input - < notes.md

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --input    输入文件，- 表示标准输入。本机输入文件或 -（stdin）；必填
  --request-id    使用此幂等键重试同一操作；CLI 省略时自动生成。1–80 位无空白请求 ID；可选

行为
  input=- 读 stdin。同请求 ID 和相同内容只追加一次。

结果
  DocChange · path, revision, bytes

全局选项见 agentero --help。
```

## `agentero paper note replace --help`

```text
用 Markdown 替换整篇论文笔记

用法
  agentero paper note replace PAPER --input INPUT --if-revision IF-REVISION

示例
  agentero paper note replace papers/atlas --input notes.md --if-revision r8

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --input    输入文件，- 表示标准输入。本机输入文件或 -（stdin）；必填
  --if-revision    提交所依据的版本，来自该对象的读取结果。上次读取所得不透明版本；必填

行为
  revision 来自 read --part notes；首次创建传 missing。保留锁定实验记录策略。

结果
  DocChange · path, revision, bytes

全局选项见 agentero --help。
```

## `agentero paper note fetch --help`

```text
获取外部论文解读并追加为带来源的笔记

用法
  agentero paper note fetch PAPER

示例
  agentero paper note fetch papers/atlas

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填

行为
  从 Cool Papers 获取并记录来源 URL；同一版本的解读重复获取时跳过。

结果
  DocChange · path, revision, bytes

全局选项见 agentero --help。
```

## `agentero paper relations --help`

```text
查看论文的参考文献及被引关系

用法
  agentero paper relations PAPER [options]

示例
  agentero paper relations papers/atlas --direction cited-by

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --direction    引用关系类型。references | cited-by | related；可选；默认 references
  --local-only    只返回已能定位到馆藏的论文。默认关闭
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  references 来自缓存的参考文献；cited-by 按本地引用缓存反查；related 是参考文献中能匹配到馆藏的子集。返回覆盖范围、匹配依据与缓存状态。

结果
  Relations · items, next_cursor, coverage, cache_state

全局选项见 agentero --help。
```

## `agentero paper regions --help`

```text
列出可直接读取的图、表、公式与文本区域

用法
  agentero paper regions PAPER [options]

示例
  agentero paper regions papers/atlas --kind table --page 8

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --kind    版面区域类别。figure | image | chart | table | algorithm | formula | section | paragraph，可重复；可选
  --page    物理页码，从 1 开始；可选
  --min-score    区域置信度下限。数值 0…1；可选；默认 0.3
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  kind 可重复，按物理页与阅读顺序排列；条目提供 region、cite 与坐标。版面缺失返回 missing_layout。

结果
  Regions · items, next_cursor

全局选项见 agentero --help。
```

## `agentero paper download --help`

```text
为已收录论文补齐来源文件

用法
  agentero paper download PAPER [--asset ASSET…] [--refresh]

示例
  agentero paper download papers/atlas --asset pdf

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --asset    选择要获取的资产。pdf | tex，可重复；可选
  --refresh    重新生成或下载受管理的缓存。默认关闭

行为
  默认补所有可取得的缺失资产；refresh 重新获取。只替换 Agentero 管理的下载缓存。

结果
  Assets · paper, assets

全局选项见 agentero --help。
```

## `agentero paper extract --help`

```text
将 PDF 文本提取成可搜索的正文

用法
  agentero paper extract PAPER [--refresh]

示例
  agentero paper extract papers/atlas

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --refresh    重新生成或下载受管理的缓存。默认关闭

行为
  生成 PAPER.md；已有有效结果默认复用。已有人工编辑的结果返回冲突。

结果
  Assets · paper, assets

全局选项见 agentero --help。
```

## `agentero paper analyze --help`

```text
生成 PDF 的页、图表与段落索引

用法
  agentero paper analyze PAPER [--provider PROVIDER] [--page PAGES] [--profile PROFILE] [--refresh]

示例
  agentero paper analyze papers/atlas --provider mineru --page 1-4,7

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --provider    指定提供方。paddle | mineru；可选
  --page    物理页从 1 起，例 8 或 1-3,7，最多 200 个不同页。
  --profile    已配置的服务、端点与认证组合。前序命令返回的标识符；可选
  --refresh    重新生成或下载受管理的缓存。默认关闭

行为
  默认使用配置的服务；profile 选择已配置的 endpoint 与凭据。--page 仅筛选保留的结果，提供方可能收到整个 PDF。

结果
  Assets · paper, assets

全局选项见 agentero --help。
```

## `agentero paper link --help`

```text
将同一篇论文列入本库另一个论文目录

用法
  agentero paper link PAPER INTO

示例
  agentero paper link papers/atlas papers/reading

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  INTO    目标论文父目录。Vault 相对目录；必填

行为
  创建目录链接并保持同一份题录，已存在的相同链接返回原结果。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero paper copy --help`

```text
将论文复制到另一个 Vault

用法
  agentero paper copy PAPER --to-vault TO-VAULT [--into INTO]

示例
  agentero paper copy papers/atlas --to-vault lab

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --to-vault    目标库；源库由 --vault 或当前目录确定。已登记库 ID；终端也接受本机 Vault 根目录；必填
  --into    目标论文父目录。Vault 相对目录；可选；默认 papers

行为
  复制资产并创建目标题录；标识已存在时返回冲突及目标引用。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero file --help`

```text
agentero file · 浏览与整理 Vault 内的文件、论文目录和回收站

用法
  agentero file <command> [options]

命令
  list          浏览 Vault 内一个目录
  write         创建、追加或替换一个 Vault 文件
  move          移动或重命名文件、目录或整篇论文
  remove        将文件或目录移入 Vault 回收站
  trash         浏览、恢复或永久清除已回收的条目

示例
  agentero file list drafts
  agentero file remove drafts/obsolete.md --dry-run

全局选项见 agentero --help。
```

## `agentero file list --help`

```text
浏览 Vault 内一个目录

用法
  agentero file list [PATH] [--hidden] [--limit LIMIT] [--cursor CURSOR]

示例
  agentero file list drafts

参数与选项
  PATH    操作的 Vault 相对路径。Vault 相对目录；可选
  --hidden    包括可访问的隐藏项。默认关闭
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  省略 path 从库根开始，只列一层。hidden 含普通隐藏项；管理目录与保留类型的约束始终生效。

结果
  Files · items, next_cursor

全局选项见 agentero --help。
```

## `agentero file write --help`

```text
创建、追加或替换一个 Vault 文件

用法
  agentero file write PATH --input INPUT [options]

示例
  agentero file write drafts/review.md --input ./review.md

参数与选项
  PATH    操作的 Vault 相对路径。规范化 Vault 相对路径；必填
  --input    输入文件，- 表示标准输入。本机输入文件或 -（stdin）；必填
  --mode    创建、追加或整体替换。create | append | replace；可选；默认 create
  --encoding    文件内容的编码。utf8 | binary；可选；默认 utf8
  --if-revision    提交所依据的版本，来自该对象的读取结果。上次读取所得不透明版本；可选
  --request-id    使用此幂等键重试同一操作；CLI 省略时自动生成。1–80 位无空白请求 ID；可选

行为
  create 遇已有文件报冲突；replace 必需 if-revision；append 仅限 UTF-8，CLI 可自动生成 request-id。Markdown 只接受 UTF-8。现有表、论文笔记、批注、版面索引与锁定实验记录依各自规则写入；新建表验证结构。创建缺失父目录。

结果
  DocChange · path, revision, bytes

全局选项见 agentero --help。
```

## `agentero file move --help`

```text
移动或重命名文件、目录或整篇论文

用法
  agentero file move SOURCE DESTINATION [--to-vault TO-VAULT] [--dry-run]

示例
  agentero file move drafts/review.md drafts/related-work.md --dry-run

参数与选项
  SOURCE    现有文件或目录的完整 Vault 相对路径。规范化 Vault 相对路径；必填
  DESTINATION    完整目标路径，含最终文件或目录名。规范化 Vault 相对路径；必填
  --to-vault    目标库；源库由 --vault 或当前目录确定。已登记库 ID；终端也接受本机 Vault 根目录；可选
  --dry-run    列出预期变更。默认关闭

行为
  destination 是完整目标路径。普通文件同库移动；论文及其组织目录可跨已授权 Vault，保留论文目录名、更新题录与双链，重名报冲突。dry-run 返回受影响条目。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero file remove --help`

```text
将文件或目录移入 Vault 回收站

用法
  agentero file remove PATHS… [--dry-run]

示例
  agentero file remove drafts/obsolete.md --dry-run

参数与选项
  PATHS    一个或多个 Vault 相对路径。规范化 Vault 相对路径，可给多项；必填
  --dry-run    列出预期变更。默认关闭

行为
  处理论文目录时一并回收题录，返回恢复 ID；同批父子路径先归并。删除前可预览。

结果
  TrashChange · items, preview

全局选项见 agentero --help。
```

## `agentero file trash --help`

```text
agentero file trash · 浏览、恢复或永久清除已回收的条目

用法
  agentero file trash <command> [options]

命令
  list          列出可恢复的回收条目
  restore       将回收的条目与题录恢复到原路径
  purge         永久清除指定回收条目

示例
  agentero file trash list

全局选项见 agentero --help。
```

## `agentero file trash list --help`

```text
列出可恢复的回收条目

用法
  agentero file trash list [--limit LIMIT] [--cursor CURSOR]

示例
  agentero file trash list

参数与选项
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  按回收时间倒序，显示原始路径。

结果
  TrashItems · items, next_cursor

全局选项见 agentero --help。
```

## `agentero file trash restore --help`

```text
将回收的条目与题录恢复到原路径

用法
  agentero file trash restore ID

示例
  agentero file trash restore t12

参数与选项
  ID    要操作的记录 ID。前序命令返回的标识符；必填

行为
  原路径已被占用时报冲突，保留回收条目。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero file trash purge --help`

```text
永久清除指定回收条目

用法
  agentero file trash purge ID [--dry-run] [--yes]

示例
  agentero file trash purge t12 --dry-run

参数与选项
  ID    要操作的记录 ID。前序命令返回的标识符；必填
  --dry-run    列出预期变更。默认关闭
  --yes    确认本命令描述的删除或解绑。默认关闭

行为
  仅接受回收 ID。非交互必须 --yes 或 --dry-run，交互确认显示原路径。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero annotation --help`

```text
agentero annotation · 在论文原文上创建和维护批注

用法
  agentero annotation <command> [options]

命令
  list          列出论文中的高亮、提问、翻译及 Agent 标记
  get           查看批注及其原文位置
  add           用原句或版面区域创建批注
  update        修改批注的备注或颜色
  remove        删除一条批注

示例
  agentero annotation list papers/atlas --page 8

全局选项见 agentero --help。
```

## `agentero annotation list --help`

```text
列出论文中的高亮、提问、翻译及 Agent 标记

用法
  agentero annotation list PAPER [--kind KIND…] [--page PAGE] [--limit LIMIT] [--cursor CURSOR]

示例
  agentero annotation list papers/atlas --page 8

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --kind    筛选已有批注的类型。highlight | ask | translate | agent-trace，可重复；可选
  --page    物理页码，从 1 开始；可选
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  按页和位置排序。

结果
  Marks · items, next_cursor

全局选项见 agentero --help。
```

## `agentero annotation get --help`

```text
查看批注及其原文位置

用法
  agentero annotation get PAPER ID

示例
  agentero annotation get papers/atlas m3

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  ID    要操作的记录 ID。前序命令返回的标识符；必填

行为
  返回定位、引用、备注、颜色及版本。

结果
  Mark · id, paper, kind, cite, locator, revision, comment, color, question, translation

全局选项见 agentero --help。
```

## `agentero annotation add --help`

```text
用原句或版面区域创建批注

用法
  agentero annotation add PAPER [options]

示例
  agentero annotation add papers/atlas --quote "batch size" --page 8 --request-id mark-17

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  --cite    search 或 read 返回的论文出处。论文 ID、Vault 相对路径或不透明 cite 引用；可选
  --quote    要定位的原句；存在歧义时返回候选引用。非空文本；可选
  --region    版面索引的区域 ID 或锚点。前序命令返回的标识符；可选
  --page    物理页码，从 1 开始；可选
  --occurrence    原句的第几次命中，从 1 起。从 1 起的整数；可选
  --all-matches    为每一个匹配位置创建批注。默认关闭
  --kind    要创建的批注类型。highlight | ask | translate；可选；默认 highlight
  --comment    批注正文；更新时可传空串清空。文本，允许空串；可选
  --question    提问内容。非空文本；可选
  --mark-color    高亮颜色。yellow | green | blue | pink | purple；可选；默认 yellow
  --language    翻译批注的目标语言。BCP 47 语言标签；可选
  --translation    直接使用这段人工译文。非空文本；可选
  --request-id    使用此幂等键重试同一操作；CLI 省略时自动生成。1–80 位无空白请求 ID；可选

行为
  cite、quote、region 三选一；cite 必须定位到该论文。occurrence 与 all-matches 互斥且仅用于 quote；重复匹配返回候选。ask 必需 question；translate 必需 language，可传人工译文，否则使用已配置翻译服务。

结果
  Marks · items, next_cursor

全局选项见 agentero --help。
```

## `agentero annotation update --help`

```text
修改批注的备注或颜色

用法
  agentero annotation update PAPER ID --if-revision IF-REVISION [options]

示例
  agentero annotation update papers/atlas m3 --comment "核对表 2" --if-revision r2

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  ID    要操作的记录 ID。前序命令返回的标识符；必填
  --comment    批注正文；更新时可传空串清空。文本，允许空串；可选
  --mark-color    高亮颜色。yellow | green | blue | pink | purple；可选
  --if-revision    提交所依据的版本，来自该对象的读取结果。上次读取所得不透明版本；必填

行为
  至少提供 comment 或 mark-color；空 comment 清空备注。

结果
  Mark · id, paper, kind, cite, locator, revision, comment, color, question, translation

全局选项见 agentero --help。
```

## `agentero annotation remove --help`

```text
删除一条批注

用法
  agentero annotation remove PAPER ID --if-revision IF-REVISION

示例
  agentero annotation remove papers/atlas m3 --if-revision r2

参数与选项
  PAPER    馆藏论文 ID 或库内论文目录。唯一论文 ID 或库内论文目录；必填
  ID    要操作的记录 ID。前序命令返回的标识符；必填
  --if-revision    提交所依据的版本，来自该对象的读取结果。上次读取所得不透明版本；必填

行为
  按指定版本删除，旧版本返回冲突。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero table --help`

```text
agentero table · 查询研究表，按记录 ID 写行或改单元格

用法
  agentero table <command> [options]

命令
  query         按记录 ID 或字段值查询表格
  upsert        按记录 ID 创建或局部更新多行
  patch         按记录 ID 和列名更新多个单元格

示例
  agentero table query experiments/results.table.json --field split --equals '"test"'

全局选项见 agentero --help。
```

## `agentero table query --help`

```text
按记录 ID 或字段值查询表格

用法
  agentero table query PATH [options]

示例
  agentero table query experiments/results.table.json --field split --equals '"test"'

参数与选项
  PATH    操作的 Vault 相对路径。规范化 Vault 相对路径；必填
  --row    表格记录的固定 ID。前序命令返回的标识符；可选
  --field    列名，与 equals 配合。非空文本；可选
  --equals    完全相等的 JSON 标量。Scalar；可选
  --archived    包含归档行。默认关闭
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  field 与 equals 成对出现。equals 是 JSON 标量，字符串须作为 JSON 字符串传入；结果含 revision、列定义和行。

结果
  Rows · revision, columns, items, next_cursor

全局选项见 agentero --help。
```

## `agentero table upsert --help`

```text
按记录 ID 创建或局部更新多行

用法
  agentero table upsert PATH --input INPUT --if-revision IF-REVISION [--request-id REQUEST-ID]

示例
  agentero table upsert experiments/results.table.json --input rows.json --if-revision r4 --request-id run-21

参数与选项
  PATH    操作的 Vault 相对路径。规范化 Vault 相对路径；必填
  --input    输入文件，- 表示标准输入。本机输入文件或 -（stdin）；必填
  --if-revision    提交所依据的版本，来自该对象的读取结果。上次读取所得不透明版本；必填
  --request-id    使用此幂等键重试同一操作；CLI 省略时自动生成。1–80 位无空白请求 ID；可选

行为
  输入为 rows 数组，仅修改给出的字段。整批校验并原子提交；相同请求重放返回首次回执。

结果
  TableChange · path, revision, changed_rows, changed_cells

全局选项见 agentero --help。
```

## `agentero table patch --help`

```text
按记录 ID 和列名更新多个单元格

用法
  agentero table patch PATH --input INPUT --if-revision IF-REVISION [--request-id REQUEST-ID]

示例
  agentero table patch experiments/results.table.json --input cells.json --if-revision r5 --request-id fix-21

参数与选项
  PATH    操作的 Vault 相对路径。规范化 Vault 相对路径；必填
  --input    输入文件，- 表示标准输入。本机输入文件或 -（stdin）；必填
  --if-revision    提交所依据的版本，来自该对象的读取结果。上次读取所得不透明版本；必填
  --request-id    使用此幂等键重试同一操作；CLI 省略时自动生成。1–80 位无空白请求 ID；可选

行为
  输入为 cells 数组；目标行和字段必须存在。重复坐标报错，整批原子提交。

结果
  TableChange · path, revision, changed_rows, changed_cells

全局选项见 agentero --help。
```

## `agentero feed --help`

```text
agentero feed · 管理订阅和订阅条目的阅读状态

用法
  agentero feed <command> [options]

命令
  list          列出本机订阅
  add           订阅 RSS、Atom 或 JSON Feed
  refresh       更新全部或一个订阅
  item          查看或标记已缓存的订阅条目
  remove        移除订阅及本机缓存条目

示例
  agentero feed list

全局选项见 agentero --help。
```

## `agentero feed list --help`

```text
列出本机订阅

用法
  agentero feed list [--limit LIMIT] [--cursor CURSOR]

示例
  agentero feed list

参数与选项
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  置顶优先，其次按添加时间。

结果
  Feeds · items, next_cursor

全局选项见 agentero --help。
```

## `agentero feed add --help`

```text
订阅 RSS、Atom 或 JSON Feed

用法
  agentero feed add URL [--title TITLE]

示例
  agentero feed add https://export.arxiv.org/rss/cs.CL

参数与选项
  URL    订阅源或同步服务地址。HTTP(S) URL；必填
  --title    显示名称或题名。非空文本；可选

行为
  支持自动发现 feed；首次拉取后返回订阅 ID。

结果
  Feed · id, title, url

全局选项见 agentero --help。
```

## `agentero feed refresh --help`

```text
更新全部或一个订阅

用法
  agentero feed refresh [--feed FEED] [--stale]

示例
  agentero feed refresh --stale

参数与选项
  --feed    仅处理此订阅 ID。前序命令返回的标识符；可选
  --stale    仅更新超过 15 分钟的订阅。默认关闭

行为
  stale 只更新上次拉取超过 15 分钟的订阅；逐源报告失败。

结果
  FeedRefresh · items

全局选项见 agentero --help。
```

## `agentero feed item --help`

```text
agentero feed item · 查看或标记已缓存的订阅条目

用法
  agentero feed item <command> [options]

命令
  list          筛选缓存的订阅条目
  mark          设置订阅条目的已读状态

示例
  agentero feed item list --kind paper --state unread

全局选项见 agentero --help。
```

## `agentero feed item list --help`

```text
筛选缓存的订阅条目

用法
  agentero feed item list [options]

示例
  agentero feed item list --kind paper --state unread

参数与选项
  --feed    仅处理此订阅 ID。前序命令返回的标识符；可选
  --state    阅读状态。read | unread；可选
  --kind    订阅条目类别。paper | other；可选
  --full    带回订阅条目的完整缓存正文。默认关闭
  --limit    本次返回的最大条目数。整数 1…200；可选；默认 50
  --cursor    从上次返回的 next_cursor 继续。同一请求返回的不透明游标；可选

行为
  时间倒序；省略筛选返回全部，full 包含源正文。

结果
  FeedItems · items, next_cursor

全局选项见 agentero --help。
```

## `agentero feed item mark --help`

```text
设置订阅条目的已读状态

用法
  agentero feed item mark ID STATE

示例
  agentero feed item mark i3 read

参数与选项
  ID    要操作的记录 ID。前序命令返回的标识符；必填
  STATE    阅读状态。read | unread；必填

行为
  只修改本机订阅条目。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero feed remove --help`

```text
移除订阅及本机缓存条目

用法
  agentero feed remove ID [--yes]

示例
  agentero feed remove f2 --yes

参数与选项
  ID    要操作的记录 ID。前序命令返回的标识符；必填
  --yes    确认本命令描述的删除或解绑。默认关闭

行为
  非交互必须 --yes。保留已经独立导入 Vault 的论文。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero translate --help`

```text
翻译一段文本或 stdin 内容

用法
  agentero translate [TEXT] [--input INPUT] --to TO [--from FROM] [--profile PROFILE]

示例
  agentero translate --to zh-CN --input - < abstract.txt

参数与选项
  TEXT    待翻译的文本。非空文本；可选
  --input    输入文件，- 表示标准输入。本机输入文件或 -（stdin）；可选
  --to    目标语言。BCP 47 语言标签；必填
  --from    源语言；auto 自动识别。BCP 47 语言标签；可选；默认 auto
  --profile    已配置的服务、端点与认证组合。前序命令返回的标识符；可选

行为
  text 和 --input 二选一。源语言省略时自动识别；--input - 支持管道。输出保留段落顺序。

结果
  Translation · text, from, to

全局选项见 agentero --help。
```

## `agentero vault --help`

```text
agentero vault · 创建、选择、检查或修复本地研究库

用法
  agentero vault <command> [options]

命令
  list          列出当前调用者可见的 Vault
  info          查看所选库、目录和目录索引状态
  create        在本机目录创建并登记一个 Vault
  check         诊断库、目录索引、链接与批注
  repair        预览或执行指定的库修复

示例
  agentero vault list

全局选项见 agentero --help。
```

## `agentero vault list --help`

```text
列出当前调用者可见的 Vault

用法
  agentero vault list

示例
  agentero vault list

行为
  终端列已登记的本地库；MCP 只列服务授予的库。返回短 ID、名称及当前库；绝对路径仅在本地终端显示。

结果
  Vaults · items

全局选项见 agentero --help。
```

## `agentero vault info --help`

```text
查看所选库、目录和目录索引状态

用法
  agentero vault info

示例
  agentero vault info --vault ./lab-papers

行为
  从当前目录的祖先也可定位库；无法选择时返回可操作的提示。

结果
  Vault · id, name, current, path, catalog_state, paper_count, outcome

全局选项见 agentero --help。
```

## `agentero vault create --help`

```text
在本机目录创建并登记一个 Vault

用法
  agentero vault create DIRECTORY [--name NAME]

示例
  agentero vault create ./lab-papers

参数与选项
  DIRECTORY    要创建的库目录。本机文件系统路径；必填
  --name    库的显示名称。非空文本；可选

行为
  目录缺省名称取最后一个路径分量，已存在的 Vault 返回 existing，非空且非 Vault 的目录报冲突。

结果
  Vault · id, name, current, path, catalog_state, paper_count, outcome

全局选项见 agentero --help。
```

## `agentero vault check --help`

```text
诊断库、目录索引、链接与批注

用法
  agentero vault check [--area AREA…] [--under UNDER]

示例
  agentero vault check --area links --under notes

参数与选项
  --area    要诊断或修复的项目。catalog | links | aliases | annotations，可重复；可选
  --under    只检查该文件或目录中的链接。规范化 Vault 相对路径；可选

行为
  无 area 时全部检查；under 只对 links 有效。返回逐项问题与建议操作，发现问题退出 1。

结果
  Health · ok, findings

全局选项见 agentero --help。
```

## `agentero vault repair --help`

```text
预览或执行指定的库修复

用法
  agentero vault repair AREA [--apply]

示例
  agentero vault repair duplicate-records

参数与选项
  AREA    要诊断或修复的项目。aliases | annotations | duplicate-records；必填
  --apply    执行已选择类型的修复。默认关闭

行为
  默认仅列出改动，--apply 才执行；目录去重保留规范记录并报告受影响 ID。

结果
  Repair · applied, items

全局选项见 agentero --help。
```

## `agentero sync --help`

```text
agentero sync · 配置并运行 Vault 同步

用法
  agentero sync <command> [options]

命令
  status        查看当前库的同步绑定和上次结果
  connect       连接指定类型的同步存储
  test          验证绑定的存储及写入能力
  run           执行一次双向同步
  disconnect    解绑当前库并移除本地同步状态

示例
  agentero sync status

全局选项见 agentero --help。
```

## `agentero sync status --help`

```text
查看当前库的同步绑定和上次结果

用法
  agentero sync status

示例
  agentero sync status

行为
  敏感字段永不返回。

结果
  SyncState · backend, location, last_run

全局选项见 agentero --help。
```

## `agentero sync connect --help`

```text
agentero sync connect · 连接指定类型的同步存储

用法
  agentero sync connect <command> [options]

命令
  s3            连接 S3 或 R2 兼容存储
  webdav        连接 WebDAV 目录
  git           连接 Git 仓库与分支

示例
  agentero sync connect s3 --bucket research --region us-east-1

全局选项见 agentero --help。
```

## `agentero sync connect s3 --help`

```text
连接 S3 或 R2 兼容存储

用法
  agentero sync connect s3 --bucket BUCKET [options]

示例
  agentero sync connect s3 --bucket research --region us-east-1

参数与选项
  --bucket    S3 兼容桶名。非空文本；必填
  --endpoint    自定义存储端点；缺省为提供方默认端点。HTTP(S) URL；可选
  --region    S3 区域。非空文本；可选；默认 us-east-1
  --prefix    桶内键名前缀。文本，允许空串；可选
  --exclude    跳过同步的资产类别。pdf | source | attachments，可重复；可选
  --credentials-input    凭证 JSON 文件或 -，内容不会回显。本机输入文件或 -（stdin）；可选

行为
  密钥来自凭据存储、隐藏提示或显式 JSON 输入；先测试连接再替换绑定。

结果
  SyncState · backend, location, last_run

全局选项见 agentero --help。
```

## `agentero sync connect webdav --help`

```text
连接 WebDAV 目录

用法
  agentero sync connect webdav URL [options]

示例
  agentero sync connect webdav https://dav.example.org/research --username lab

参数与选项
  URL    订阅源或同步服务地址。HTTP(S) URL；必填
  --username    WebDAV 用户名。非空文本；可选
  --journal    启用独立目录的 WebDAV 日志模式。默认关闭
  --exclude    跳过同步的资产类别。pdf | source | attachments，可重复；可选
  --credentials-input    凭证 JSON 文件或 -，内容不会回显。本机输入文件或 -（stdin）；可选

行为
  journal 使用普通 PUT 日志，需独立同步目录，返回协商结果。

结果
  SyncState · backend, location, last_run

全局选项见 agentero --help。
```

## `agentero sync connect git --help`

```text
连接 Git 仓库与分支

用法
  agentero sync connect git REMOTE [options]

示例
  agentero sync connect git git@example.org:lab/vault.git --branch main

参数与选项
  REMOTE    Git 仓库地址或本机路径。Git 远程地址或本机仓库路径；必填
  --branch    同步分支。非空文本；可选；默认 main
  --ca-file    PEM CA 文件。本机文件系统路径；可选
  --allow-insecure-http    允许明文 HTTP Git 远程连接。默认关闭
  --exclude    跳过同步的资产类别。pdf | source | attachments，可重复；可选

行为
  认证使用系统 Git/SSH 凭据；ca-file 是 PEM CA 文件。

结果
  SyncState · backend, location, last_run

全局选项见 agentero --help。
```

## `agentero sync test --help`

```text
验证绑定的存储及写入能力

用法
  agentero sync test

示例
  agentero sync test

行为
  可能创建并清理远端探测对象，返回分项结果。

结果
  SyncTest · ok, checks

全局选项见 agentero --help。
```

## `agentero sync run --help`

```text
执行一次双向同步

用法
  agentero sync run

示例
  agentero sync run

行为
  返回上传、下载、冲突副本与可重试项；争用同步锁返回 busy。

结果
  SyncRun · uploaded, downloaded, conflicts, errors

全局选项见 agentero --help。
```

## `agentero sync disconnect --help`

```text
解绑当前库并移除本地同步状态

用法
  agentero sync disconnect [--yes]

示例
  agentero sync disconnect --yes

参数与选项
  --yes    确认本命令描述的删除或解绑。默认关闭

行为
  远端对象保留；非交互需要 --yes。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero app --help`

```text
agentero app · 打开桌面视图、安排分栏、展示回合产物

用法
  agentero app <command> [options]

命令
  open          在桌面打开 Vault、文档、论文或引用
  views         列出桌面窗口及可定位的视图
  split         在工作区拆分当前视图或并排打开文档
  close         关闭一个桌面视图
  window        打开或聚焦一个功能窗口
  present       将本回合生成的 Vault 文件放到聊天产物卡片

示例
  agentero app open papers/atlas
  agentero app views

全局选项见 agentero --help。
```

## `agentero app open --help`

```text
在桌面打开 Vault、文档、论文或引用

用法
  agentero app open [TARGET]

示例
  agentero app open papers/atlas

参数与选项
  TARGET    桌面目标引用或 SSH 工作区 ID。论文 ID、Vault 相对路径或不透明 cite 引用；可选

行为
  省略 target 打开所选 Vault。可唤起桌面；已打开正文时聚焦，引用尽量跳到原始位置。

结果
  View · view, window, path

全局选项见 agentero --help。
```

## `agentero app views --help`

```text
列出桌面窗口及可定位的视图

用法
  agentero app views [--window WINDOW]

示例
  agentero app views --window main

参数与选项
  --window    Tauri 窗口 label。前序命令返回的标识符；可选

行为
  返回 Tauri 窗口 label、Dockview 视图 ID、路径和活动状态，供 split/close。

结果
  Views · items

全局选项见 agentero --help。
```

## `agentero app split --help`

```text
在工作区拆分当前视图或并排打开文档

用法
  agentero app split [TARGET] [--beside BESIDE] [--direction DIRECTION] [--window WINDOW]

示例
  agentero app split notes/ideas.md --beside view-123

参数与选项
  TARGET    桌面目标引用或 SSH 工作区 ID。论文 ID、Vault 相对路径或不透明 cite 引用；可选
  --beside    作为分栏基准的视图 ID。前序命令返回的标识符；可选
  --direction    新视图相对基准视图的位置。right | left | above | below | within；可选；默认 right
  --window    Tauri 窗口 label。前序命令返回的标识符；可选

行为
  beside 是源视图 ID；无 target 时拆分源视图，缺省源为活动视图。

结果
  View · view, window, path

全局选项见 agentero --help。
```

## `agentero app close --help`

```text
关闭一个桌面视图

用法
  agentero app close VIEW [--window WINDOW]

示例
  agentero app close view-123 --window main

参数与选项
  VIEW    Dockview 面板 ID。前序命令返回的标识符；必填
  --window    Tauri 窗口 label。前序命令返回的标识符；可选

行为
  view 是 Dockview 面板 ID，窗口省略时由宿主定位，遵守现有关闭策略与保存否决。

结果
  Receipt · changed, items, preview

全局选项见 agentero --help。
```

## `agentero app window --help`

```text
打开或聚焦一个功能窗口

用法
  agentero app window FEATURE [--section SECTION]

示例
  agentero app window settings

参数与选项
  FEATURE    功能窗口类型。settings | agent | annotations；必填
  --section    设置页面标识。前序命令返回的标识符；可选

行为
  section 仅适用于 settings。

结果
  Window · window

全局选项见 agentero --help。
```

## `agentero app present --help`

```text
将本回合生成的 Vault 文件放到聊天产物卡片

用法
  agentero app present PATHS… [--title TITLE]

示例
  agentero app present outputs/comparison.md --title "实验对照"

参数与选项
  PATHS    一个或多个 Vault 相对路径。规范化 Vault 相对路径，可给多项；必填
  --title    显示名称或题名。非空文本；可选

行为
  新增的桌面回合能力。文件必须已写入；title 限单文件。返回可打开引用，预览由现有文件查看器按类型决定；需宿主回合绑定。

结果
  Artifacts · items

全局选项见 agentero --help。
```

## `agentero delegate --help`

```text
agentero delegate · 向已连接的远端研究工作区提交任务

用法
  agentero delegate <command> [options]

命令
  targets       列出可委派的已连接 SSH 工作区
  run           向指定工作区提交远端 Agent 任务
  result        读取任务状态及已有结果
  cancel        请求取消仍在执行的远端任务

示例
  agentero delegate targets

全局选项见 agentero --help。
```

## `agentero delegate targets --help`

```text
列出可委派的已连接 SSH 工作区

用法
  agentero delegate targets

示例
  agentero delegate targets

行为
  依赖桌面 SSH 会话与平台支持。

结果
  Targets · items

全局选项见 agentero --help。
```

## `agentero delegate run --help`

```text
向指定工作区提交远端 Agent 任务

用法
  agentero delegate run TARGET --input INPUT [--request-id REQUEST-ID]

示例
  agentero delegate run gpu-lab --input task.md --request-id job-17

参数与选项
  TARGET    桌面目标引用或 SSH 工作区 ID。前序命令返回的标识符；必填
  --input    输入文件，- 表示标准输入。本机输入文件或 -（stdin）；必填
  --request-id    使用此幂等键重试同一操作；CLI 省略时自动生成。1–80 位无空白请求 ID；可选

行为
  input 为 UTF-8 任务说明。立即返回任务 ID，执行目录由目标绑定决定。

结果
  Job · id, state, result

全局选项见 agentero --help。
```

## `agentero delegate result --help`

```text
读取任务状态及已有结果

用法
  agentero delegate result JOB [--wait WAIT]

示例
  agentero delegate result j9 --wait 30

参数与选项
  JOB    远端任务 ID。前序命令返回的标识符；必填
  --wait    最多等待的秒数。整数 0…300；可选；默认 0

行为
  wait 为最长等待秒数；超时返回当前状态。

结果
  Job · id, state, result

全局选项见 agentero --help。
```

## `agentero delegate cancel --help`

```text
请求取消仍在执行的远端任务

用法
  agentero delegate cancel JOB

示例
  agentero delegate cancel j9

参数与选项
  JOB    远端任务 ID。前序命令返回的标识符；必填

行为
  已经终止的任务返回最终状态；取消与任务完成可能竞态。

结果
  Job · id, state, result

全局选项见 agentero --help。
```

## `agentero mcp --help`

```text
agentero mcp · 为外部客户端运行或检查工具服务

用法
  agentero mcp <command> [options]

命令
  serve         向客户端启动一个 Agentero MCP 服务
  tools         查看给定启动配置实际会发布的工具

示例
  agentero mcp tools --json
  agentero mcp serve --vault lab

全局选项见 agentero --help。
```

## `agentero mcp serve --help`

```text
向客户端启动一个 Agentero MCP 服务

用法
  agentero mcp serve [options]

示例
  agentero mcp serve --vault lab --allow full-text

参数与选项
  --transport    stdio 或本机 Streamable HTTP。stdio | http；可选；默认 stdio
  --allow-vault    附加允许访问的 Vault，可重复。已登记库 ID；终端也接受本机 Vault 根目录，可重复；可选
  --allow    追加授予的工具能力，可重复。full-text | write | online，可重复；可选
  --listen    loopback 地址与端口。loopback 地址和端口，0 由系统分配；可选；默认 127.0.0.1
  --token-input    HTTP bearer token 文件或 -。本机输入文件或 -（stdin）；可选

行为
  所选库为默认库，--allow-vault 可重复追加其它授权库。HTTP 只绑定 loopback，需 token-input 或系统凭据；stdio 只输出协议帧。listen、token-input 仅用于 http。

结果
  Server · transport, address

全局选项见 agentero --help。
```

## `agentero mcp tools --help`

```text
查看给定启动配置实际会发布的工具

用法
  agentero mcp tools [--allow-vault ALLOW-VAULT…] [--allow ALLOW…]

示例
  agentero mcp tools --vault lab --allow write --json

参数与选项
  --allow-vault    附加允许访问的 Vault，可重复。已登记库 ID；终端也接受本机 Vault 根目录，可重复；可选
  --allow    追加授予的工具能力，可重复。full-text | write | online，可重复；可选

行为
  使用相同发布规则，--json 返回 tools/list 的 result 对象，含输入输出 schema；无需启动监听。

结果
  Tools · tools

全局选项见 agentero --help。
```

## `agentero help --help`

```text
查看任意命令的帮助或结构化定义

用法
  agentero help [COMMAND…]

示例
  agentero help paper import pdf

参数与选项
  COMMAND    从根开始的命令路径，各层用空格分隔。规范命令路径中的一个词，可给多项；可选

行为
  不带路径显示根帮助，路径可逐级跟进；--json 输出相应子树的参数、互斥组、结果与示例。

结果
  Help · 命令定义

全局选项见 agentero --help。
```
