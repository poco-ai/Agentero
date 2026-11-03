# 网页论文阅读与划词

「网页」类论文（paper `type === "html"`，有 `html_url` 无本地 PDF）由 `HtmlViewer`（`src/components/viewer/html-viewer.tsx`）以内嵌 iframe 阅读。从 PDF 标签打开的 arXiv HTML 不走下面这条代理，见 [pdf.md](pdf.md)。跨域 iframe 受同源策略约束,父页面拿不到选区——划词工具栏、翻译、Quick chat 全部失效。解法是把页面经内置通用代理加载,并注入一段"桥"脚本进页面上下文(近似浏览器扩展的 content script)。

## 架构

```text
HtmlViewer ── iframe src: agentero-web://localhost/<host>/<path>
    │  (加载前 invoke web_proxy_allow_host 把 host 加入 allowlist)
    ▼
Host `features/web/proxy.rs`(agentero-web scheme)
    ├─ allowlist 校验(discovery/proxy 之外唯一允许任意 host 的代理,绝不开放中继)
    ├─ reqwest 转发(浏览器 UA;重定向每跳都过 allowlist)
    └─ text/html 且 looks_like_document → 重构建响应:
        剥掉上游 CSP / X-Frame-Options,在 <head> 开标签后注入
        <base href="https://<host>/<dir>/"> + WEB_BRIDGE 脚本
```

### `<base href>` 注入

把文档的相对资源解析基准设回真实 origin,因此:

- 相对 / 根相对 / 协议相对的 CSS、图片、字体(含 CSS 内部 `url()`)全部**直接从站点加载,不经代理**——代理不用为 CDN 开任何上游(SSRF 面与广场代理同一条红线);
- 零 HTML 属性改写(不用 regex 扫 `src=`/`href=`);
- 只有**页面导航**需要留在代理里,由桥的 click 拦截器改写回 `/<host><path>` 形态。

### URL 双形态

与 `arxivReaderUrl` 同一约束:Windows WebView2 把自定义 scheme 拦截为 `http://<scheme>.localhost`。构造与 `event.origin` 校验统一走 `src/lib/web-view/proxy-url.ts`(`webViewProxyUrl` / `webViewProxyOrigins`,后者两种形态都接受)。

网页论文、本地 HTML 预览与广场 iframe 共用 `src/hooks/use-iframe-drag-shield.ts`：捕获 `dragstart` 后暂停 iframe 命中测试，`dragend` / `drop` 后恢复，使拖放事件能到达 Dockview；各查看器的授权、导航与 sandbox 规则仍独立维护。

## 安全边界(Host 侧)

| 防线 | 实现 |
|---|---|
| 绝不做开放中继 | 进程级 allowlist(`features/web/allowlist.rs`);前端打开 paper 前 `web_proxy_allow_host` ensure |
| SSRF | allowlist 只收公网 DNS 名;拒绝 IP 字面量 / localhost / `.local` / `.internal` / `.arpa` / 无点主机 |
| 重定向绕过 | 自定义 reqwest redirect Policy:每一跳 host 都必须已在 allowlist,否则整请求报错(而非透传 3xx) |
| 凭据泄露 | 只转发 content-type / accept / accept-language,不带 cookie / Origin |
| 路径穿越 | `target_from_uri` 拒绝 `..` 与无 host 段的形态 |

## 桥脚本(WEB_BRIDGE)

NAV_BRIDGE 同款 vanilla ES5 IIFE,只装配顶层 frame。经 `parent.postMessage` 与应用通信;应用侧监听 `message` 并校验 `event.origin ∈ webViewProxyOrigins()` 、`event.source === iframe.contentWindow` 且 `data.source === "agentero-web"`(防无关 frame 伪造)。

### 消息协议

| 方向 | type | 载荷 | 语义 |
|---|---|---|---|
| frame → app | `selection` | `{text(≤4000), rect\|null, url}` | 选区(视口坐标矩形);空文本即清菜单。带 rect 时帧内已 `execCommand("copy")`(焦点在 frame,应用侧剪贴板写入可能被拒的降级) |
| frame → app | `scroll` | — | 页内滚动,隐藏工具栏(plaza 同款语义) |
| frame → app | `ready` | — | 桥完成监听后请求当前快捷键配置；每次文档导航重新握手 |
| frame → app | `shortcut` | `{event: {key, code, metaKey, ctrlKey, altKey, shiftKey}}` | 仅转发匹配的配置；应用以 `resolveShortcutId` 再校验。可编辑元素、IME 与普通输入不转发 |
| frame → app | `external` | `{url}` | 跨站链接交系统浏览器 |
| app → frame | `shortcuts` | `{bindings: ShortcutDef[], isMac}` | 同步 toggleChat / quickChat / addSelectionToChat 的有效配置；禁用不传。桥 ready、iframe load 和设置变更均同步 |
| app → frame | `clearSelection` | — | 加入对话后清除帧内选区 |
| app → frame | `copySelection` | — | 应用侧复制失败时的兜底 |

站内导航:同 host 链接被改写为 `/<host><path>` 原地导航(每次文档加载都重新注入桥);SPA 的 `pushState`/`replaceState` 被包装以保留 host 段;非 http(s) scheme 的链接直接阻止(私有 scheme 绝不漏给系统浏览器)。

## 划词动作管线(前端)

`use-web-view-selection.ts`(`src/components/viewer/web-view/`)消费桥消息,产出与 PDF / plaza 同款的浮层:

- **工具栏**:`SelectionMenu`(复用 `viewer/pdf/cards/`,`showHighlight={false}`——网页无 marks/,藏高亮留翻译)+ 选中即复制标签 `SelectionCopiedLabel`;
- **翻译**:`TranslateCard` 流式卡,双 provider 执行在共享引擎 `lib/pdf/translate/run-selection.ts`(agent → `runOnce{workflow:"translate"}` 流式;免费 MT → `runTranslate`;与 PDF 划词复用),ephemeral 单卡不写 marks;
- **Quick chat ⌘K**:`AskPopover` + 共享 `use-selection-ask.ts`(从 plaza 抽出的 ephemeral ask 生命周期:`PdfAskThread` + 共享引擎 `lib/pdf/ask/run-turn.ts` 的 `runOnce{workflow:"free"}` + `attachAgentRun` 流式,plaza 改为消费方);
- **加入对话 ⇧⌘L**:`addSelectionToChat`(= `publishSelection` + `pinActiveSelection` + `presentAgentComposer({ preserveCaret: true })`)。

默认 `⌘L` 仅切换 Agent 侧栏，即使有选区也不 pin；`⇧⌘L` 才加入选区并打开、聚焦 composer，`⌘K` 保留页内 Quick chat。网页 iframe 中后两者只在有选区时转发。PDF / Plaza / 网页工具栏提示通过 `useShortcutLabel` 跟随用户配置。

四个划词表面(PDF / plaza / 网页论文 / 文本编辑器)共用 `src/components/selection/` 下的三件套:`use-copied-label.ts`(自动复制的 copied 确认标签,1000ms 自隐藏)、`use-selection-quick-chat.ts`(⌘K 注册,ref 守卫 mount 稳定 + armed 谓词)、`add-selection-to-chat.ts`(发布 + pin + 打开 Agent 侧栏);ask 生命周期在 `use-selection-ask.ts`。各表面只保留自己的来源 origin、几何信息与 dismissal 编排。

坐标换算:`bridgeSelectionScreen(rect, iframeRect)`(桥给的是 frame 视口坐标,加 iframe 元素偏移即应用视口坐标),纯函数在 `bridge-message.ts`,与消息 parse 守卫一起有 vitest 覆盖。

## 已知限制

- **登录站 / 部分 SPA**:站点 JS 以 `location.origin` 拼 API 请求会打到代理 scheme 上失败(评论区、站内搜索等残缺)。公开文章与文档站基本不受影响。
- **高亮 / 批注持久化**:网页无 marks/ sidecar,v1 不提供;如后续要做,需在 catalog 或 sidecar 定义网页锚点(文本 quote + 版本)。
- **跨 host 重定向**:重定向目标 host 必须也在 allowlist(如 www → 裸域),否则该请求报错——SSRF 边界优先。
- 剪贴板:首选应用侧 `copyTextToClipboard`,被拒时桥内 `execCommand("copy")` 已先行复制。

## 本地 HTML 文件

Vault 中的 `.html` / `.htm`（论文目录下的子文件、`notes/` 里的图）由 `LocalHtmlViewer`（`src/components/viewer/local-html-viewer.tsx`）预览。远程论文页仍走上面的 `HtmlViewer`。Markdown 笔记或 Agent 对话里的本地 HTML 链接会在活动面板右侧分屏打开这个 viewer（#825）。

```text
打开 logic.html
  → html_preview_grant(绝对路径) → { token, name }
  → iframe src: agentero-html://localhost/t/<token>/<name>?v=<htmlKey>
  → Host 只读该文件所在目录（含子目录）
```

Windows 上地址是 `http://agentero-html.localhost/t/...`。`sandbox="allow-scripts"`。磁盘上的同一文件变更会增加 `htmlKey`，iframe 重新加载，不必把全文读进 React state。

适合 Skill 写出的单文件图（内联 SVG / CSS / 脚本）。同目录的 `./fig.svg` 可以显示。远程脚本、`fetch`、表单、弹窗和跳出该目录的路径都不放行。字体允许 Google Fonts；要完全离线，生成时改用系统字体。

划词、翻译、加入对话不接在这个 iframe 上。源码编辑也不在预览里。

## 相关

- 广场各站专属代理(固定 origin,不做任意 host):`docs/development/plaza.md`
- PDF 划词(持久化 marks 的对照实现):[pdf.md](pdf.md)
- Host 契约：[../backend/api.md](../backend/api.md) §3.6.3


## RSS 与网页入库边界

当前 Translator 返回 `webpage` 时可映射为 `html` 条目，Connector / Zotero 迁移复用同一数据模型；打开网页条目可同时使用 `NOTES.md`。这不保证任意 URL 都能解析，也不等于正文已经离线归档。RSS 条目已支持右键「入库」及详情工具栏入库：论文优先用论文 URL，普通网页用来源 URL，复用上述解析链路。后续设计与验收清单见 [网页收藏入库（#821）](../development/webpage-library.md)。

订阅列表已支持打开详情自动标记已读、灰色标题、隐藏已读和恢复未读；阅读状态只写订阅缓存，不创建 Vault 条目。具体边界见 [订阅读取状态](../development/plaza-feeds.md#订阅读取状态已实现)。
