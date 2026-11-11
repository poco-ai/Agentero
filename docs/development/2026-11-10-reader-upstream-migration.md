# 阅读器迁移到最新上游的执行计划

**目标：** 在上游 `66ecc12675b55612221e077161009ae3b914b198`（0.15.5）上保留已验证的连续阅读、引用/公式修复与阅读时长，生成经过原生 Windows 验收的新试用包。此前 0.15.4 基线与测试保留为中间证据。

**设计：** 以上游共享翻译任务、Host 原子缓存写入、通用选区菜单和页面渲染为主线，接入本地阅读能力。提取器的选页行为与缓存参数分开传递；算法升级使旧字符缓存失效，缓存读取后恢复样式共享。阅读视图订阅官方任务/缓存结果，关闭视图不取消他人拥有的后台任务。

**技术：** Tauri 2、React 19、TypeScript、PDFium/EmbedPDF、Vitest、Rust、Windows WebView2。

## 约束

- 旧工作区 `E:/Desktop/agertero` 的文件与暂存状态保留；迁移分支为 `feat/reader-upstream-20261110`，独立路径 `D:/agentero-migration-20261110/source`。
- 旧快照、补丁、index 与逐文件哈希存于迁移目录的 `original-workspace`。旧 0.15.1 ZIP 不覆盖。
- 不按论文题名/DOI/页码特判，不修改 Zotero 原 PDF，不添加 OCR 或老论文排版范围。
- 不派子代理。打包阶段不发布、不推送；2026-11-11 用户随后要求先提交 PR，使用已认证 GitHub 账号的 noreply 身份创建草稿 PR，另一台测试机的持续验收待补充。

## 执行与验收

### 1. 基线与三方整合

- [x] 备份 194 个变动文件、暂存补丁及 index；创建固定上游工作树。
- [x] 独立安装 lockfile 依赖，跑上游相关基线测试。
- [x] 对本地改动按旧基线进行逐文件三方合并，保留上游新增与删除。
- [x] 处理阅读工具栏、导航、菜单、重排覆盖层、settings 和 i18n 冲突；文档保留双方有效内容。

### 2. 缓存与生命周期

文件：`src/lib/pdf/reflow/{service,cache,extract}.ts`、`src/components/viewer/pdf/hooks/use-pdf-continuous-reader.ts`、`src/lib/pdf/layout/layout-translate.ts`。

- [x] 用最小失败回归证明：整篇阅读请求不能被仅选中页缓存截断；旧算法缓存不能复用；读缓存后相同样式共享对象。
- [x] 保留 `prepareReflowItems` 官方 cache 参数，额外传递提取选项并遍历所需全部页。
- [x] 提升字符 IR 算法版本；对 cache hit/miss 都做文档级样式复用。
- [x] 用测试覆盖 Host 写入完成后阅读视图收到更新；使用官方共享翻译结果及取消语义。

### 3. 译文与交互整合

文件：`pdf-viewer.tsx`、`layers/reflow-page-overlay.tsx`、`cards/selection-menu.tsx`、`hooks/use-pdf-layout-translate.ts`。

- [x] 同时保留官方逐句译文高亮与本地多引用边界分割，使用真实 translatedOffset。
- [x] 保留官方部分译文恢复和共享任务状态，原文/译文按钮继续服务阅读视图。
- [x] 移除新增网页 AI provider、界面、桥接监听器和 IPC；划词继续复用现有 Agent 的提问与加入聊天。
- [x] 单栏阅读卸载隐藏源页；上下/左右分屏与退出恢复；检查新增译文文档资源生命周期。

### 4. 检查与新包

- [x] TypeScript、改动范围 Biome、`pnpm deps:check`、本地及上游相关 Vitest；新增故障测试先失败再通过。
- [x] 移除桥接后重新生成 bindings，执行 bindings 和 events_contract 校验及相关 Rust 测试。
- [x] 严格 MkDocs 构建；更新迁移记录、当前限制和 Windows 试用说明。
- [x] 移除桥接后重新冻结源码清单，完成原生 Windows release + NSIS 构建。
- [x] 最终包四篇打开；九篇 Wiley 的 770 处引用逐位置双模式悬停（1,540 次），核对 1,544 个成员；已有译文组合、分母、公式与实际条目内容；AIP/Oxford/Springer 代表引用；缓存冷/热重开。
- [x] 分屏、原文定位、跳转返回、全部关闭、重开、原生退出；自然内存采样与前包同环境比较，明确短时边界。
- [x] 新 ZIP 完整性与 SHA256；交付新路径和具体上游基线，不把旧包证据替代新包。

## 追加修复（交包前）

用户要求先修复截图中的分屏、移除网格，并补齐阅读选区动作。第二版安装包及冻结清单保存在工作树外 `before-reader-ui-fixes`，不作为这些新增行为的验收证据。

- [x] `pdf-reading-popover.tsx`、`use-pdf-reading-mode.ts`、settings：删除 grid 入口与专用 spread 实现，旧 grid 配置自动回退 vertical；测试确保 PDF 分屏不再开启阅读模式。
- [x] `pdf-viewer.tsx`、`pdf-translation-viewer-inner.tsx`：PDF 分屏独立于阅读分屏；内嵌官方精简译文窗格，复用共享任务和缓存；打开分屏不自动启动新翻译，单栏和退出释放资源。
- [x] `reading/selection.ts`、reader DOM、选区 hook：为可见文字与公式保留 UTF-16 offset，原文选择精确定位源字形，译文按已有句对定位；复用公共菜单和批注持久化，不把 reader 像素写入 PDF 坐标。
- [x] 阅读视图中呈现高亮与可编辑批注；验证选择、复制、翻译入口、跨段/跨页、公式前后、高亮/笔记保存重开与取消。
- [x] 研究本机 Zotero 10.0.8 与固定公开源码中的引用分组和预览回退；使用两篇 AI Magazine 的副本对照原文/译文及组合引用，不按论文身份特判。Zotero AGPL 代码只作方法参考，不复制进 MIT 工程。
- [x] 收敛后统一执行相关 Vitest、tsc、依赖检查、文档检查和原生 Windows 构建；在最终包上重新执行九篇 Wiley 及四篇既有样本、分屏/选区/引用、关闭重开与内存验收。

本轮新包补查的原生批注载入时序、阅读批注动作栏遮挡和 Host 翻译缓存通知已纳入实现与回归。最终新包证据统一见 [上游迁移试用](../test/2026-11-10-upstream-reader-trial.md)，不复用中间包 PASS。

2026-11-11 创建草稿 PR #1077 后，仅在独立 PR 副本整合上游 `9c5a3bf4f` 的九个提交，解决三处冲突并复测。交付安装包仍对应原冻结版本；新增整合的自动检查与待完成的安装包／第二台机器验收见同一试用报告末节。阅读时长仍留在本地独立变更中，媒体不附到 PR。
