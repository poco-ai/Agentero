# PDF 批注导入因日期字符串失败，留下不可删高亮

2026-11-12。重现于 `papers/2607.13705`：编辑批注后进程中断，重开时页面上仍有黄色高亮，但点不中、删不掉。真实 Vault 的 `marks/annotations.json` 里，高亮条目的 `created` 是 ISO 字符串。

## 原因

1. `saveAnnotationItems` 用 `JSON.stringify` 落盘，`Date` 变成 ISO 字符串；`loadAnnotationItems` 只做 `JSON.parse`，没有还原。
2. `importAnnotations` 把保存的对象交给 PDFium。引擎的 `applyBaseAnnotationProperties` 只看字段是否为真，随后 `dateToPdfDate(annotation.created)` 直接调用 `getUTCFullYear()`；字符串没有该方法，`createPageAnnotation` 任务 reject。
3. 插件在 commit 前已把注解 dispatch 进内存态，commit 失败不回滚，`hasPendingChanges` 保持为 true。高亮仍被渲染层画出，但后续任何 commit 都会带上这个失败项，永远无法结算。
4. 删除时注解被标为 `deleted`：命中测试按 `commitState` 过滤它，渲染层不过滤；删除协调器又只在 `hasPendingChanges` 为 false 时补删。于是出现「看得见、选不中、删不掉」，编辑备注也不会真正写入引擎。

`#783` 修的是删除竞态和僵尸注解，但前提是 commit 最终能结算；导入本身失败会让这条链路永久卡住，属于它未覆盖的分支。

## 修复

- `src/lib/pdf/highlight/annotation-items.ts` 增加 `reviveAnnotationDates`：读取时把 `created` / `modified` 的 ISO 字符串还原为 `Date`，无法解析的值丢弃（引擎会按缺省跳过）。
- `src/lib/pdf/highlight/annotation-store.ts` 的 `marks/` 与旧根目录两条读取路径统一走 `parseAnnotationItems`。

不重写原 PDF，也不改 EmbedPDF 插件；已有的 `annotations.json` 无需手工修改。

## 验证

- `test/pdf-annotation-items.test.ts` 覆盖 JSON 往返、已是 `Date` 时保持原引用、非法日期被丢弃。
- 相关 `pdf-annotation-sync` / `pdf-highlight-history-io` 测试、`pnpm typecheck`、`pnpm deps:check` 通过。
- 已污染的旧会话需要完全退出应用后重开，让注解重新导入；日志中不应再出现 `createPageAnnotation ... date.getUTCFullYear is not a function`。
