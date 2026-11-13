# 应用内划词动作

PDF、RSS 正文、arXiv Daily 摘要、Markdown 笔记、Agent 消息正文、文本编辑器、网页论文和广场代理页面共享划词动作。范围是应用内已接入的阅读区域；普通输入框和未接入的第三方窗口保持原有行为。

## 组件与入口

| 层 | 接口 | 职责 |
|---|---|---|
| 工具栏 | `components/selection/selection-action-menu.tsx` | 翻译、复制、加入对话、快速对话；动作回调可选；`beforeActions` / `afterActions` 组合业务扩展 |
| DOM 正文 | `SelectionSurface` | 用 `source` 提供来源，注册正文区域并在卸载时取消对应瞬态结果；`autoCopy` 保留 RSS 原有自动复制行为 |
| 已有编辑器 / 消息根节点 | `selectionSurfaceProps` + `useSelectionSource` | 不增加 DOM 包装；沿用编辑器的格式工具栏和选区发布机制 |
| 特殊选区 | `openSelectionChat(input, screen)` | CodeMirror 和跨域 iframe 把选区快照交给窗口宿主 |
| 窗口宿主 | `SelectionChatPopover` + `SelectionActions` | 一个窗口一个 DOM 监听器和动作控制器；共享翻译、Quick chat 和加入对话直接固定流程 |
| PDF 扩展 | `viewer/pdf/cards/selection-menu.tsx` | 组合高亮色、笔记和插件动作；书签收进「更多」菜单。继续使用 PDF 的几何锚点、持久化 Ask / 翻译流程 |

新增正文入口示例：

```tsx
<SelectionSurface
  source={{
    sourcePath: article.url,
    sourceUrl: article.url,
    sourceTitle: article.title,
    origin: "markdown",
    surface: "web",
  }}
>
  <ArticleBody />
</SelectionSurface>
```

`origin` 保留现有 `pdf / markdown / chat` 存储与定位语义；可选 `surface` 区分 feed、web、abstract、text、markdown、chat。不要把 URL 或虚拟订阅路径伪装成 Vault 文件。

## 交互与生命周期

- 鼠标完成选区或键盘扩展选区后显示工具栏。两个端点必须在同一注册正文内；输入框、工具栏自身、IME 输入不会触发正文捕获。
- `⌘K` / `Ctrl+K` 打开快速对话，`⇧⌘L` / `Ctrl+Shift+L` 将快照加入 Agent；实际快捷键和工具栏提示跟随设置。点击加入对话直接固定引用并聚焦 Agent 输入框，不再先弹批注输入框。
- 工具栏打开时，`T` 翻译、`C` 复制选中文字；PDF 的 `N` 添加批注、`B` 添加书签（书签在「更多」菜单里），`1–5` 依次选择黄、绿、蓝、粉、紫色高亮，`⌥1–5` 直接创建对应颜色的下划线（不改变该色的记忆形状）。颜色组收起时也可直接按数字选色，无需悬停展开；这些选区快捷键优先于 PDF Vim 的数字跳页和搜索导航。LaTeX 的添加批注同样使用 `N`。单键提示显示在按钮悬停提示中，输入文字、输入法组字、长按重复和其他对话框内的按键不触发；唯一的修饰键组合是颜色组的 `⌥` 数字前缀。工具栏关闭或相应按钮隐藏时不响应；翻译结果卡同时打开时，`C` 优先复制新选区。
- 工具栏按实际宽度放置，并以最后一次光标位置为中心、跟随手势结束侧：向下拖选时在光标下方，向上拖选时在光标上方；靠近边缘时翻转或限位。PDF 调色板展开预留空间，扩展操作不挤动锚点；定位时从色块组固定的右边界测量操作区，避免宽度动画中的小数像素误差使按钮抖动。「更多」下拉沿用工具栏的底色、发丝描边和 28px 行高，字号与悬停色同样对齐栏内按钮。
- 选区快照携带选区矩形（DOM Range、CodeMirror 行框或 iframe 桥坐标）。翻译卡在选区下方打开（空间不足时才翻到侧边或上方）；快速对话卡优先在选区上方打开，空间不足时翻到另一侧或侧边，避免盖住正在阅读的原文；PDF 的 Ask 卡继续锚在页边针旁。
- 点击外部、滚动、收起选区或 Escape 收起工具栏。翻译 / Ask 卡保留原文快照；新选区不会替换已打开 Ask 的问题。来源卸载、切换工作区标签或 Vault 会关闭瞬态请求。
- 翻译与 Ask 每次请求使用独立的取消引用；即使 Agent 尚未完成发现或接受请求，关闭后也不能用晚到结果覆盖新卡。PDF 与普通正文共享一个窗口的翻译卡所有权。
- RSS / 网页 / 消息 / 文本 Quick chat 只存在本次浮层中，不写 PDF `marks/`；PDF 原有持久化行为保持不变。

## 来源与 Agent 上下文

`SelectionContext` 的标题、URL、消息 ID、行号、PDF 页码和文本锚点随选区冻结，并通过 composer token 保留。来源按钮优先定位仍在页面内的原文；网页没有可用 DOM 锚点时打开原始 URL。

Vault 选区交给 Host 上下文解析器。RSS、网页和消息引文携带标题、链接及原文进入编号引用附录，不为虚拟路径授予文件访问权限。引文作为证据，不作为 Agent 指令。

## iframe 桥

`lib/web-view/selection-bridge.js` 是唯一的选区 / 快捷键脚本。通用网页代理、Cool Papers、ModelScope、Papers with Code 通过 Rust `include_str!` 注入；受信的 arXiv `srcdoc` 使用同一脚本。站点导航仍由各代理自己的桥处理。脚本在构建期编入 Host，改完要重启 `pnpm tauri dev`（或任何 Rust 重建）；只靠前端 HMR 不会更新已注入的代理页面。

父窗口同时校验消息来源标记、代理 origin 和发送窗口身份；`null` origin 仅显式用于对应的沙盒 `srcdoc`。坐标按 iframe 偏移与广场缩放比例换算。导航后的公开 URL 从代理路径还原，来源记录不保存代理地址。

键盘事件不会穿出跨域 frame：桥转发匹配的快捷键，当前网页的选区工具栏打开时同步启用 `T` / `C`，关闭后撤销；父窗口校验来源后交给同一个工具栏动作。桥在 window 捕获阶段把非输入元素上的 `Escape` 作为 `escape` 消息交给父窗口，SPA 站点为自己的浮层调用 `stopPropagation` / `preventDefault` 也不会吞掉它；桥不拦截 Escape，站点自己的 Escape 行为不受影响。共享选区宿主收到后关闭工具栏 / 结果卡。

## 限制与后续

- 沿用现有选区上限 4000 字符和最多 4 个固定引用；完整文章引用仍走原有整条加入对话入口。
- PDF 自动划词翻译设置仍只影响 PDF；其他区域由用户点击翻译，避免选择文本时自动发起网络请求。
- 本地 HTML 的严格沙盒和未接入的任意外部 iframe 不注入选区脚本；系统级跨应用划词不在本次范围。
- 网页 / RSS 的持久化高亮、批注和跨文档选区尚未提供。
