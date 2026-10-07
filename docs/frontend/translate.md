# 翻译

应用级可插拔翻译：内置 provider + 免费 MT + 商用 BYOK + BYOA Agent。

## 设置

Settings → **翻译**：

- **默认服务** 下拉：内置 provider（构建里注入了 key 时）、免费 MT 与 Agent 始终可选；商用仅列出已配置者。打开下拉时对内置（可用时）、免费 MT 与已配置商用并行 probe。
- **内置 provider**（id `agentero`）：凭证由构建期环境变量编入 Host，卡片**没有任何凭证字段**（无 key / baseUrl / model）。可见性来自 Host 命令 `builtin_provider_status` 的 `available`；可用时与其他免费引擎一样参与 probe（真的发一次 "Hi" 翻译请求，顺带验证网关连通），不可用（构建里没有 key）时不 probe、选项禁用或隐藏，当前已选中它时仍保留在列表里。构建里没有 key 时选中它会拿到 `translate.no_builtin_key` 标记，由 `displayTranslateError`（`src/lib/translate/errors.ts`，仿 `displayAgentError`：子串匹配标记 → `i18n.t(...)`，否则原样返回）在划词翻译与全文翻译的 `notifyError` 调用点转成文案，不裸露标记串。标记能到前端是因为 `invokeTranslateText`（`src/lib/translate/api.ts`）只对**已知**翻译标记逐字抛出 `error.code`，其余情况抛 Host 的人类可读 `message`——`AppError::code()` 还会返回 `io` / `json` / `sqlite` 等通用码，按"非 `message` 即标记"判断迟早会把裸码弹给用户。注入 key 的构建里它是新装默认服务——新装没有 `settings.json`，Host `read_file` 返回 `AppSettings::default()`，所以**首次安装的默认值由 Rust `default_translate_provider()` 决定**；前端 `DEFAULT_TRANSLATE_SETTINGS` 只在浏览器 dev（不可能有 key）里生效。
- 目标语言、划词自动翻译；开启后，PDF 选区文本提取完成即自动启动翻译并打开结果卡，关闭时仍可从选区菜单手动翻译。
- **CNKI 翻译助手**（免费引擎，id `cnki`）：知网 dict.cnki.net 逆向接口，学术术语翻译质量好、校园网可用，但仅**中英互译**；超过 800 字符自动按句切分串行翻译（块间约 2s 防风控，长文耗时相应拉长）；CNKI 边缘会随机直接断连（非 HTTP 错误），Host 复用带 cookie 的浏览器客户端（第一次成功响应后即持有 CNKI 的放行 cookie）并对每个请求自动退避重试、无需用户干预，仅连续失败才报错；触发验证码时按提示到 dict.cnki.net 手动过一次验证码后重试；海外 IP 通常不可用（404）。详见 [../backend/translate.md](../backend/translate.md)。
- **商用 API** 卡片仅填写 key / endpoint / region / model；点「确定」后：
  - 将 API key 写入 Host `settings.json`（Unix 权限 `0600`）；WebView 只保留同长度 `*` 掩码，不再回显明文。
  - Host `settings_get` / `settings:changed` 对 key 按字符 redact 为 `*`；`settings_set` 收到纯 `*` 串时保留原密钥。
  - `translate_text` 在 key 缺省或为 `*` 掩码时从 Host 配置解析真实密钥。
  - 随后做一次连通性 probe。卡片不承担「设为默认」选择。
  - OpenAI 兼容翻译要求服务支持 **Chat Completions** 格式：`POST {baseUrl}/chat/completions`，返回 `choices[0].message.content`。设置里填写 Base URL（例如 `https://api.openai.com/v1` 或服务商自己的 `/v1` 根地址），不要填写 Responses / Completions 端点；应用会自动追加 `/chat/completions`。
    用户配置说明见 [配置 OpenAI 兼容翻译](../usage/translate-openai-compatible.md)。
- 默认服务为 Agent 时展示 Agent / 模型座。
- **自定义翻译提示词**（`translate.customPrompt`，空 = 内置）：非空时整体替换默认指令块（角色 + 规则），仅对 **Agent 与 OpenAI 兼容**两条 LLM 路径生效（免费引擎与内置 provider 无提示词概念）。支持 `{{targetLang}}` / `{{sourceLang}}` 变量（display name；源语言恒为自动检测 → "the source language"）；**原文与 `[[n]]` 批量规则始终由应用自动追加**，不提供 `{{text}}` 变量，提示词极简也不会破坏批量切分。「填入默认」把当前内置提示词填进输入框供修改，「恢复默认」清空。上限 8000 字符。OpenAI 兼容路径的提示词由 Host 在 `translate_text` 内从 settings 注入（WebView 调用方无感）。

## 消费方

- PDF 划词菜单「翻译」（首要入口）。
  - 结果卡贴合选区锚点（`trackPin`），PDF 滚轮滚动时随页重定位。
  - 通过卡片关闭按钮、`Esc` 或点击卡片外部可收起；选区锚点随滚动累计移动超过 200px 时也会收起卡片。关闭未钉住的卡片会丢弃译文；如果仍在生成，会尝试取消 Agent 任务并忽略迟到结果。已经开始的保存会先写完，再删除对应文件。已钉住的译文关闭卡片后仍会保留。原文浅黄高亮在卡片收起后保留。
  - 有本地论文路径时，打开期间的结果和 `pinned` 状态写入 `{paper}/marks/<id>.json`；新译文默认未钉住，旧 JSON 缺少 `pinned` 时按已钉住读取，保留升级前的页边入口，不涉及 SQLite 迁移。
  - 磁盘刷新保留正在生成、等待保存或删除的本地译文，避免焦点切换或外部文件更新覆盖当前结果；刷新期间发生的本地修改也优先保留。保存或删除失败通过 Toast 提示，并保留当前内存状态。
  - 卡片在本地存储路径和选区定位都有效时显示钉住开关，提示为「钉住 / 取消钉住」。钉住会同时保留译文记录和页边重开入口；取消钉住会立即移除页边标记，但卡片仍保持打开，关闭后才丢弃译文。卡片关闭后没有单独的删除按钮。每次翻译建立独立记录，流式更新不会清掉当前钉住状态。同一位置的页边标记会纵向错开；多行选区的标记锚定在选区末行，空间不足时仍保持在页面内。
- PDF **全文翻译**（工具栏 Languages，在视觉批注旁）：
  - 依赖版面分析 + PDF 文字层；翻译 `text` / `abstract` / `header` / `figure_title`（图题·表题）区域（score ≥ 30%）。
  - **不翻译**：算法框及其内部文字；`reference` / `reference_content` 文献条目；“References / Bibliography / 参考文献” 标题；侧栏 `aside_text`。
  - **译前归一化**（`normalizeLayoutSourceText`）：文字层是空白折叠后的单行串，先合并行末连字符断词（`repre- sentation` → `representation`，`pre- and` 这类并列保留）、展开 ligature / 去 soft hyphen、清掉落在正文 bbox 里的 arXiv 戳与会议 boilerplate、剥掉句末后粘着的页码与续段前的行号（`Table 2` 这类交叉引用不动，`header` 不做数字剥离）。
  - **跨页/跨栏段落合并**（#340）：一个段落被分栏、分页或图表切开时是多个 region。末尾无句末标点、下一片段以小写开头则判为续段，先拼成一个 chain（≤ 4 片段 / 4000 字符）。切句在归一化之前，用文字层原文（`raw`，没有则退回 `source`），连字符保留，所以 quote 仍是 `repre- sentation`。拉丁 `.` `!` `?` 要后面有空白或已经到结尾才切句；`。` `！` `？` 单独即可。`et al.`、`Fig.`、`e.g.`、`i.e.` 和小数不切。发给引擎的是归一化后的句子。一句跨栏、跨页仍是一个编号；译文只在这一句内部按各片段原文长度切回 bbox。块上的 `translated` 是该块各句译文切片按目标语言拼接（中文直接相连）。图题不打断 chain，`header` 打断。chain 内任一片段缺译文即整条重译。
  - **段落边界与安全扩框**：文字层会按真实行间距将被模型合并的相邻正文段落拆成独立 bbox。标题和图表 caption 的译文估算行宽超过原文 10% 时，覆盖层才会向无检测内容的右侧或下侧留白扩展（最多原框的 1.5× 宽或 1.75× 高）；遇到任何版面检测框即停止，扩展失败才走行距/字号拟合。正文不借用周围空间，避免不完整的版面检测遮住邻栏内容。
  - **占位符保护**（`src/lib/translate/mask.ts`）：行内公式 / LaTeX 命令 / URL / DOI 先换成 `⟦n⟧` 再发引擎，回填时还原；引擎吞掉占位符则该句用原文重译一次。
  - 按阅读顺序把句子**分批**翻译（`buildTranslateBatches`）：批内 payload ≤ 4500 字符（约一页双栏正文），用 `[[n]]` 编号，一个标记一句。标记解析失败时该批改为逐句重译；某一句仍失败则该块不写 `sentences`。成功时每块写入句对 `{ quote, source, translated }`，跨框切片另记 `display`。并发 2（Agent 串行）；**每批完成立刻**在 bbox 上盖译文层（非整页等齐）。这里的并发 2 是**前端批次**并发，与内置 provider 在 Host 内对单批做的句级 fan-out（并发 3）正交：选内置时同时在飞的请求最多 2 × 3。
  - 每页纸张右上角外侧常驻窄页签可只翻译本页；页签 hover 不弹出额外文字；本页已有可见译文时，页签切换为隐藏本页译文。隐藏只影响当前 UI 覆盖层，不删除磁盘缓存。
  - 译文按论文写入 `{paper}/source/layout-translate.json`（`schemaVersion` 2）。版本不对的文件整份视为未命中，按块重译。缓存命中需匹配 provider / 源语言 / 目标语言 / 非密钥服务配置，并逐块校验 region id + 原文（存的是归一化后的原文，归一化规则变化时旧缓存会 miss 一次并重译）；版面或目标语言变化时只复用仍匹配的块。句对随块写入；没有句对的块只复用整段译文。自定义翻译提示词非空时,service key 追加其 FNV-1a 指纹——改提示词即重译；空提示词的 key 与旧版字节一致,存量缓存升级后仍命中。
  - 单页翻译写缓存时按同一 cache key 增量合并，避免只翻译一页时覆盖其它页已经落盘的译文。
  - 运行中再点=停止；有译文再点=清除。实现：`layout-translate.ts` + `layout-translate-source.ts` + `layout-sentences.ts` + `layout-translate-overlay.tsx`。
  - 翻译失败（如内置 provider 返回 502）时 toast 为「全文翻译失败」加错误描述，并带「打开翻译设置」动作（`use-pdf-layout-translate.ts` 的 `notifyTranslateFailure` → `openSettingsWindow("translate")`，带动作时停留 20s），与版面解析失败的设置跳转一致。
  - 覆盖层按当前 PDF 页面背景 tone 绘制纸面底色（深字）。有句对且各句切片能拼回块译文时，每句是一个 `data-sentence` span，句间空格只在块译文本身带空格时插入；拼不回去则整段仍是一个文本节点。暗色下套用与页面栅格相同的 invert filter（`PDF_PAGE_RASTER_DARK_CLASS`），使盖住原文的底色与反转后的纸面一致。纸面在划词高亮和已有英文高亮之下，字形在高亮之上。在译文上新建的高亮另存划中区域的页比例坐标。译文显示时画这套坐标，不画英文文字层的框；没有这套坐标的高亮是翻译前在英文上做的。译文打开时，翻译前的英文高亮用自己的文字层字形框去对每一句英文的字形框，重叠的那一句才铺原来的颜色，不写回批注。文字层还没读到时只铺整句对得上的高亮，一段文字不会套到同页的每一句上。在译文 span 上划选时，半句扩成该句整句英文，连续几句只保留这几句。贴着上一句的边界起笔、但没有划中上一句的字时，不把上一句算进去；这一块没有句对时退回整段英文。高亮和批注写入英文 `quote`、这一句的文字层字形框，以及划中译文的页比例坐标。对不上整块版面时不拿整块来填。回到英文时画字形框。复制仍是划中的译文。选区菜单和右侧批注条跟划中的译文区域走；焦点进入批注后，这块区域仍画在译文上。点到输入框以外时，写了字就落成批注并交出焦点，没写就收起这块选区。提问和加入对话把配对译文当作当次上下文，不写进批注。英文文字层上的划选仍按字形。笔记里的批注嵌入对得上时在原文下显示译文，见 [wiki.md](wiki.md)。选中译文时墨色跟纸面走（浅纸黑字、暗纸浅字），不用界面的前景色，避免深色主题把选中的黑字反成浅色。这条要同时写在段落和句 span 上：WebKit 不把段落的 `::selection` 传给里面的 span，span 会落回界面前景色。排版先以原文尺度估算、再用真实浏览器度量校验：译文膨胀时依次收紧行距（1.25 → 1.10）、缩小字号；遵循严格 CJK 断行，只有不可断的 URL/标识符仍溢出时才允许词内断行。因此普通段落不会过早缩成极小字，并尽量避免裁掉译文。
  - **双栏翻译**（Settings → 翻译 →「翻译显示模式」选「双栏对照」）：全文翻译按钮在原文右侧打开只读译文 PDF 面板（同页栈 + 译文覆盖层，隐藏工具栏/选区菜单）。左右各是独立 EmbedPDF 实例，通过模块级 peer 注册表（`src/lib/pdf/scroll-sync.ts` + `usePdfScrollSync`）双向同步**滚动比例**与**缩放**（scroll 事件按动画帧合并）；任一侧滚轮滚动或 Ctrl/Cmd+滚轮缩放，另一侧跟到同一相对位置。译文面板走精简 `PdfTranslationViewerInner`：只挂 raster/tiling/zoom 等核心插件（不挂 ONNX 版面分析、批注、搜索、PDF 选区插件，也不调用对应 capability hooks）。译文覆盖层文字可以选中，并显示选区底色；页面层只渲染纸面 + 译文覆盖；打开时优先读 `layout-translate.json` 缓存，避免与源面板抢跑第二套翻译/版面任务。侧栏不挂批注插件，主阅读器上的英文高亮淡底不会出现在侧栏。
- API：`runTranslate(task)`（`src/lib/translate/`）。

## Prompt

`buildTranslatePrompt`（Agent 路径）与 Host `openai_translate_prompt`（OpenAI-compatible 路径）共用同一套约束，改一处要同步另一处：

- 定位为学术论文译者；要求**按意思重组语序**（可拆长句），而不是逐词直译。
- 公式 / 符号 / 变量 / 单位 / 行内代码 / URL / 引用标记 / 图表公式编号 / `⟦n⟧` 占位符原样保留。
- 术语用领域惯用译法并保持一致，首次出现补原文，如 `注意力机制（attention）`。
- 不增删、不解释、不加译注和 markdown 围栏；只输出译文。
- 批量 payload 里每个 `[[n]]` 是一句。保留全部标记、顺序和编号，不跨编号搬运、不合并、不丢弃。一个编号内部可以调整语序，也可以把一句原文拆成多句译文。
- OpenAI-compatible 的 `temperature` 用 0.2（0.0 的直译感太强）。

**内置 provider（`agentero`）不适用以上整套约束**：`tencent/Hunyuan-MT-7B` 是专用 MT 模型而非 instruct 模型，只认它自己的单行模板，Host 改发单条 user message（无 system message），并且**不把 `[[n]]` 喂给模型**——批量对齐依赖指令遵循，对它无效，所以标记由 Host 拆分、逐句请求、按序重组。`⟦n⟧` 占位符仍由前端 `mask.ts` 插入并原样透传。详见 [../backend/builtin-provider.md](../backend/builtin-provider.md) §翻译：Hunyuan-MT。

**自定义提示词（`translate.customPrompt` 非空）替换语义**：前端 `buildTranslatePrompt` 用它整体取代默认指令块（内置模板抽成 `DEFAULT_TRANSLATE_PROMPT_TEMPLATE`，空值渲染结果与旧版字节一致）；Host `openai_translate_messages` 用它取代 system message（`{{targetLang}}`/`{{sourceLang}}` 插值，映射与前端 `targetLangDisplayName` 一致）。两条路径都保留应用侧追加的 `[[n]]` 批量规则与 `Text:` 原文。改一处要同步另一处的约定不变。

## 路径

| 类型 | 路径 |
|---|---|
| 内置 provider | Host `translate_text`（`agentero` → Hunyuan-MT，构建期凭证，无凭证卡片） |
| 免费 MT | Host `translate_text`（腾讯交互翻译 / 火山 Web / DeepLX / 知网 CNKI / Google gtx） |
| 商用 BYOK | Host `translate_text`（DeepL / Azure / Google Cloud / OpenAI-compatible） |
| Agent | `agent_run_once` + 翻译 prompt；同一篇文献的多次翻译复用同一个 ACP provider session |

结果可写入 `marks/`（划词）。Host 细节：[../backend/translate.md](../backend/translate.md)。

## 限制与后续

字词对齐，以及把滚动同步从页面比例改成句子对齐，留在后续。译文上的高亮用划选时记下的页比例坐标，不是事后按矩形反查英文。侧栏译文面板不共享主阅读器的高亮，英文高亮的淡底只画在主阅读器。当时的方案留在 [../development/translate-sentence-anchor.md](../development/translate-sentence-anchor.md)。
