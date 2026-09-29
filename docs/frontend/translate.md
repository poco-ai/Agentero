# 翻译

应用级可插拔翻译：内置 provider + 免费 MT + 商用 BYOK + BYOA Agent。

## 设置

Settings → **翻译**：

- **默认服务** 下拉：内置 provider（构建里注入了 key 时）、免费 MT 与 Agent 始终可选；商用仅列出已配置者。打开下拉时对免费 MT 与已配置商用并行 probe。
- **内置 provider**（id `agentero`）：凭证由构建期环境变量编入 Host，卡片**没有任何凭证字段**（无 key / baseUrl / model）。可用性来自 Host 命令 `builtin_provider_status` 的 `available`，**不参与 probe**（探测它会真的发一次翻译请求）；不可用时选项禁用或隐藏，当前已选中它时仍保留在列表里。构建里没有 key 时选中它会拿到 `translate.no_builtin_key` 标记，由 `displayTranslateError`（`src/lib/translate/errors.ts`，仿 `displayAgentError`：子串匹配标记 → `i18n.t(...)`，否则原样返回）在划词翻译与全文翻译的 `notifyError` 调用点转成文案，不裸露标记串。标记能到前端是因为 `invokeTranslateText`（`src/lib/translate/api.ts`）只对**已知**翻译标记逐字抛出 `error.code`，其余情况抛 Host 的人类可读 `message`——`AppError::code()` 还会返回 `io` / `json` / `sqlite` 等通用码，按"非 `message` 即标记"判断迟早会把裸码弹给用户。注入 key 的构建里它是新装默认服务——新装没有 `settings.json`，Host `read_file` 返回 `AppSettings::default()`，所以**首次安装的默认值由 Rust `default_translate_provider()` 决定**；前端 `DEFAULT_TRANSLATE_SETTINGS` 只在浏览器 dev（不可能有 key）里生效。
- 目标语言、划词自动翻译；开启后，PDF 选区文本提取完成即自动启动翻译并打开结果卡，关闭时仍可从选区菜单手动翻译。
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
  - 通过卡片的关闭按钮、`Esc` 或点击卡片外部可收起；收起不删除记录。翻译仍在生成时收起卡片，任务会继续并保存结果，完成后不会重新弹出；选区锚点随滚动累计移动超过 200px 时也会收起卡片。
  - 删除翻译卡后，迟到的翻译结果不会重新写回；已经开始的保存完成后才删除对应文件。
  - 收起只隐藏卡片，不会删除已保存的翻译记录；只有「删除」操作会移除对应文件。
- PDF **全文翻译**（工具栏 Languages，在视觉批注旁）：
  - 依赖版面分析 + PDF 文字层；翻译 `text` / `abstract` / `header` / `figure_title`（图题·表题）区域（score ≥ 30%）。
  - **不翻译**：算法框及其内部文字；`reference` / `reference_content` 文献条目；“References / Bibliography / 参考文献” 标题；侧栏 `aside_text`。
  - **译前归一化**（`normalizeLayoutSourceText`）：文字层是空白折叠后的单行串，先合并行末连字符断词（`repre- sentation` → `representation`，`pre- and` 这类并列保留）、展开 ligature / 去 soft hyphen、清掉落在正文 bbox 里的 arXiv 戳与会议 boilerplate、剥掉句末后粘着的页码与续段前的行号（`Table 2` 这类交叉引用不动，`header` 不做数字剥离）。
  - **跨页/跨栏段落合并**（#340）：一个段落被分栏、分页或图表切开时是多个 region。末尾无句末标点、下一片段以小写开头则判为续段，拼成一个 chain 作为**原子翻译单元**（≤ 4 片段 / 4000 字符），译文再按各片段原文长度加权、在句末→分句→空白边界切回各自 bbox。图题不打断 chain，`header` 打断。chain 内任一片段缺译文即整条重译。
  - **段落边界与安全扩框**：文字层会按真实行间距将被模型合并的相邻正文段落拆成独立 bbox。标题和图表 caption 的译文估算行宽超过原文 10% 时，覆盖层才会向无检测内容的右侧或下侧留白扩展（最多原框的 1.5× 宽或 1.75× 高）；遇到任何版面检测框即停止，扩展失败才走行距/字号拟合。正文不借用周围空间，避免不完整的版面检测遮住邻栏内容。
  - **占位符保护**（`src/lib/translate/mask.ts`）：行内公式 / LaTeX 命令 / URL / DOI 先换成 `⟦n⟧` 再发引擎，回填时还原；引擎吞掉占位符则该 chain 用原文重译一次。
  - 按阅读顺序把 chain **分批**翻译（`buildTranslateBatches`）：批内 payload ≤ 4500 字符（约一页双栏正文），用 `[[n]]` 编号拼成一次请求，让引擎看到上下文；译文按 `[[n]]` 标记切回、逐块写回原 bbox 位置。标记解析不一致时该批**回退为逐段翻译**，保证不丢块。并发 2（Agent 串行）；**每批完成立刻**在 bbox 上盖译文层（非整页等齐）。这里的并发 2 是**前端批次**并发，与内置 provider 在 Host 内对单批做的段级 fan-out（并发 3）正交：选内置时同时在飞的请求最多 2 × 3。
  - 每页纸张右上角外侧常驻窄页签可只翻译本页；页签 hover 不弹出额外文字；本页已有可见译文时，页签切换为隐藏本页译文。隐藏只影响当前 UI 覆盖层，不删除磁盘缓存。
  - 译文按论文写入 `{paper}/source/layout-translate.json`。缓存命中需匹配 provider / 源语言 / 目标语言 / 非密钥服务配置，并逐块校验 region id + 原文（存的是归一化后的原文，归一化规则变化时旧缓存会 miss 一次并重译）；版面或目标语言变化时只复用仍匹配的块。自定义翻译提示词非空时,service key 追加其 FNV-1a 指纹——改提示词即重译；空提示词的 key 与旧版字节一致,存量缓存升级后仍命中。
  - 单页翻译写缓存时按同一 cache key 增量合并，避免只翻译一页时覆盖其它页已经落盘的译文。
  - 运行中再点=停止；有译文再点=清除。实现：`layout-translate.ts` + `layout-translate-source.ts` + `layout-translate-overlay.tsx`。
  - 覆盖层按当前 PDF 页面背景 tone 绘制纸面底色（深字）；暗色下套用与页面栅格相同的 invert filter（`PDF_PAGE_RASTER_DARK_CLASS`），使盖住原文的底色与反转后的纸面一致。排版先以原文尺度估算、再用真实浏览器度量校验：译文膨胀时依次收紧行距（1.25 → 1.10）、缩小字号；遵循严格 CJK 断行，只有不可断的 URL/标识符仍溢出时才允许词内断行。因此普通段落不会过早缩成极小字，并尽量避免裁掉译文。
  - **双栏翻译**（Settings → 翻译 →「在侧窗中打开渲染好的翻译」）：全文翻译按钮在原文右侧打开只读译文 PDF 面板（同页栈 + 译文覆盖层，隐藏工具栏/选区菜单）。左右各是独立 EmbedPDF 实例，通过模块级 peer 注册表（`src/lib/pdf/scroll-sync.ts` + `usePdfScrollSync`）双向同步**滚动比例**与**缩放**（scroll 事件按动画帧合并）；任一侧滚轮滚动或 Ctrl/Cmd+滚轮缩放，另一侧跟到同一相对位置。译文面板走精简 `PdfTranslationViewerInner`：只挂 raster/tiling/zoom 等核心插件（不挂 ONNX 版面分析、批注、搜索、选区，也不调用对应 capability hooks），页面层只渲染纸面 + 译文覆盖；打开时优先读 `layout-translate.json` 缓存，避免与源面板抢跑第二套翻译/版面任务。
- API：`runTranslate(task)`（`src/lib/translate/`）。

## Prompt

`buildTranslatePrompt`（Agent 路径）与 Host `openai_translate_prompt`（OpenAI-compatible 路径）共用同一套约束，改一处要同步另一处：

- 定位为学术论文译者；要求**按意思重组语序**（可拆长句），而不是逐词直译。
- 公式 / 符号 / 变量 / 单位 / 行内代码 / URL / 引用标记 / 图表公式编号 / `⟦n⟧` 占位符原样保留。
- 术语用领域惯用译法并保持一致，首次出现补原文，如 `注意力机制（attention）`。
- 不增删、不解释、不加译注和 markdown 围栏；只输出译文。
- 批量 payload 额外要求保留 `[[n]]` 标记、顺序与段数，不合并段落。
- OpenAI-compatible 的 `temperature` 用 0.2（0.0 的直译感太强）。

**内置 provider（`agentero`）不适用以上整套约束**：`tencent/Hunyuan-MT-7B` 是专用 MT 模型而非 instruct 模型，只认它自己的单行模板，Host 改发单条 user message（无 system message），并且**不把 `[[n]]` 喂给模型**——批量对齐依赖指令遵循，对它无效，所以标记由 Host 拆分、逐段请求、按序重组。`⟦n⟧` 占位符仍由前端 `mask.ts` 插入并原样透传。详见 [../backend/builtin-provider.md](../backend/builtin-provider.md) §翻译：Hunyuan-MT。

**自定义提示词（`translate.customPrompt` 非空）替换语义**：前端 `buildTranslatePrompt` 用它整体取代默认指令块（内置模板抽成 `DEFAULT_TRANSLATE_PROMPT_TEMPLATE`，空值渲染结果与旧版字节一致）；Host `openai_translate_messages` 用它取代 system message（`{{targetLang}}`/`{{sourceLang}}` 插值，映射与前端 `targetLangDisplayName` 一致）。两条路径都保留应用侧追加的 `[[n]]` 批量规则与 `Text:` 原文。改一处要同步另一处的约定不变。

## 路径

| 类型 | 路径 |
|---|---|
| 内置 provider | Host `translate_text`（`agentero` → Hunyuan-MT，构建期凭证，无凭证卡片） |
| 免费 MT | Host `translate_text`（腾讯交互翻译 / 火山 Web / DeepLX / Google gtx） |
| 商用 BYOK | Host `translate_text`（DeepL / Azure / Google Cloud / OpenAI-compatible） |
| Agent | `agent_run_once` + 翻译 prompt；同一篇文献的多次翻译复用同一个 ACP provider session |

结果可写入 `marks/`（划词）。Host 细节：[../backend/translate.md](../backend/translate.md)。
