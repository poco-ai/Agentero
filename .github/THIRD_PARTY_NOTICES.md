# 第三方开源组件与许可证披露

> 适用版本：Agentero 0.11.9 及之后版本。基线生成日期：2026-10-18。
> 本文件面向使用者与分发者，说明 Agentero 随发行物提供的第三方开源组件、版本与许可证。完整传递依赖以 `pnpm-lock.yaml`、`Cargo.lock` 和 `src-tauri/adapters/manifest.json` 为准。

## 1. 披露范围

本披露覆盖 Agentero 桌面应用（macOS / Windows / Linux）、`agentero` CLI、移动端共享的前端资源，以及安装包内随附的第三方二进制、模型与字体。

不包含：

- 开发、测试与构建工具链（如 Vite、Biome、Clippy）；
- 用户自行安装的 Agent CLI（Claude Code、Codex 等）及其依赖；
- 用户在设置中自行配置的第三方 API 服务；
- 用户 Vault 中的论文、笔记与其他个人数据。

## 2. 随发行物分发的第三方组件

| 组件 | 版本 | 许可证 | 用途 | 上游 |
| --- | --- | --- | --- | --- |
| PDFium（桌面动态库与 WASM） | chromium/7897 | BSD-3-Clause | PDF 渲染与文本提取 | https://pdfium.googlesource.com/pdfium/ |
| Tesseract OCR | 5.3.4（经 `tesseract-rs` 0.2.0 静态构建） | Apache-2.0 | 扫描版 PDF 的 OCR 回退 | https://github.com/tesseract-ocr/tesseract |
| Leptonica | 1.84.1 | BSD-2-Clause | Tesseract 图像处理依赖 | http://www.leptonica.org/ |
| tessdata_best（eng / tur） | 构建时快照 | Apache-2.0 | Tesseract 语言数据 | https://github.com/tesseract-ocr/tessdata_best |
| ONNX Runtime Web | 1.27.0 | MIT | 浏览器内版面模型推理 | https://github.com/microsoft/onnxruntime |
| PP-DocLayoutV3 ONNX | fp16 转换版 | Apache-2.0 | PDF 版面检测模型 | https://github.com/PaddlePaddle/PaddleOCR |
| EmbedPDF 运行时与 PDFium WASM | 2.14.4 | MIT（PDFium 部分为 BSD-3-Clause） | PDF 查看器运行时 | https://www.embedpdf.com/ |
| EmbedPDF 多语言字体 | 1.0.0 | OFL-1.1 | PDF 中日韩等字体回退 | https://www.embedpdf.com/ |
| Geist Variable | 5.2.9 | OFL-1.1 | 界面字体 | https://fontsource.org/fonts/geist |
| Claude Agent ACP Adapter | 0.79.0 | Apache-2.0 | 内置 ACP Adapter 离线回退 | https://github.com/agentclientprotocol/claude-agent-acp |
| Codex ACP Adapter | 1.12.0 | Apache-2.0 | 内置 ACP Adapter 离线回退 | https://github.com/agentclientprotocol/codex-acp |
| realtime-tex（rtex-core / rtex-dl / TeX 支持文件） | 0.0.5 | MIT | LuaLaTeX 实时段落预览 | https://github.com/HenryXiaoYang/realtime-tex |
| realtime-tex VS Code 预览渲染器（移植） | 0.0.5 | MIT | display list → Canvas 渲染 | https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin |

> 内置的两个 ACP Adapter 是独立的 npm 依赖树，其传递依赖以 MIT / ISC / BSD / Apache-2.0 为主。完整清单见 `scripts/prepare-adapters.mjs` 固定的版本与 `src-tauri/adapters/manifest.json`。

## 3. 前端直接依赖

以下为 `package.json` 中的生产依赖（其中 `tailwindcss` / `@tailwindcss/vite` 仅在构建期使用）。版本以本次基线解析结果为准；升级依赖后请同步更新本表。

| 包 | 版本 | 许可证 | 上游 |
| --- | --- | --- | --- |
| `@codemirror/autocomplete` | 6.20.3 | MIT | https://code.haverbeke.berlin/codemirror/autocomplete |
| `@codemirror/lang-json` | 6.0.2 | MIT | https://github.com/codemirror/lang-json |
| `@codemirror/lang-python` | 6.2.1 | MIT | https://github.com/codemirror/lang-python |
| `@codemirror/language` | 6.12.4 | MIT | https://code.haverbeke.berlin/codemirror/language |
| `@codemirror/legacy-modes` | 6.5.4 | MIT | https://code.haverbeke.berlin/codemirror/legacy-modes |
| `@codemirror/lint` | 6.9.7 | MIT | https://code.haverbeke.berlin/codemirror/lint |
| `@codemirror/state` | 6.7.4 | MIT | https://code.haverbeke.berlin/codemirror/state |
| `@codemirror/view` | 6.43.11 | MIT | https://code.haverbeke.berlin/codemirror/view |
| `@embedpdf/ai` | 0.0.1 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/core` | 2.14.4 | MIT | https://www.npmjs.com/package/@embedpdf/core |
| `@embedpdf/engines` | 2.14.4 | MIT | https://www.embedpdf.com/docs/engines/introduction |
| `@embedpdf/models` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/pdfium` | 2.14.4 | MIT | https://www.embedpdf.com/docs/pdfium/introduction |
| `@embedpdf/plugin-ai-manager` | 0.0.1 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-annotation` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-bookmark` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-document-manager` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-interaction-manager` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-layout-analysis` | 0.0.1 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-render` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-scroll` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-search` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-selection` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-spread` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-tiling` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-viewport` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@embedpdf/plugin-zoom` | 2.14.4 | MIT | https://www.embedpdf.com/docs |
| `@flowershow/remark-wiki-link` | 3.4.0 | MIT | https://github.com/flowershow/remark-wiki-link#readme |
| `@fontsource-variable/geist` | 5.2.9 | OFL-1.1 | https://fontsource.org/fonts/geist |
| `@lezer/highlight` | 1.2.3 | MIT | https://github.com/lezer-parser/highlight |
| `@pdf-lib/fontkit` | 1.1.1 | MIT | https://github.com/Hopding/fontkit |
| `@platejs/basic-nodes` | 53.0.0 | MIT | https://platejs.org |
| `@platejs/code-block` | 53.0.0 | MIT | https://platejs.org |
| `@platejs/dnd` | 53.1.0 | MIT | https://platejs.org |
| `@platejs/find-replace` | 53.0.0 | MIT | https://platejs.org |
| `@platejs/footnote` | 53.0.0 | MIT | https://platejs.org |
| `@platejs/indent` | 53.0.0 | MIT | https://platejs.org |
| `@platejs/list` | 53.1.3 | MIT | https://platejs.org |
| `@platejs/markdown` | 53.2.2 | MIT | https://platejs.org |
| `@platejs/math` | 53.0.0 | MIT | https://platejs.org |
| `@platejs/media` | 53.1.4 | MIT | https://platejs.org |
| `@platejs/mention` | 53.0.0 | MIT | https://platejs.org |
| `@platejs/selection` | 53.1.6 | MIT | https://platejs.org |
| `@platejs/table` | 53.0.9 | MIT | https://platejs.org |
| `@platejs/toc` | 53.0.0 | MIT | https://platejs.org |
| `@radix-ui/react-toolbar` | 1.1.15 | MIT | https://radix-ui.com/primitives |
| `@radix-ui/react-tooltip` | 1.2.12 | MIT | https://radix-ui.com/primitives |
| `@radix-ui/react-use-controllable-state` | 1.2.3 | MIT | https://radix-ui.com/primitives |
| `@stepperize/react` | 7.0.0 | MIT | https://stepperize.vercel.app |
| `@streamdown/cjk` | 1.0.3 | Apache-2.0 | https://github.com/vercel/streamdown |
| `@streamdown/code` | 1.1.1 | Apache-2.0 | https://github.com/vercel/streamdown |
| `@streamdown/math` | 1.0.2 | Apache-2.0 | https://github.com/vercel/streamdown |
| `@streamdown/mermaid` | 1.0.2 | Apache-2.0 | https://github.com/vercel/streamdown |
| `@tailwindcss/vite` | 4.3.2 | MIT | https://tailwindcss.com |
| `@tanstack/react-virtual` | 3.14.6 | MIT | https://tanstack.com/virtual |
| `@tauri-apps/api` | 2.11.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri#readme |
| `@tauri-apps/plugin-deep-link` | 2.4.9 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-dialog` | 2.7.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-fs` | 2.5.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-log` | 2.9.0 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-opener` | 2.5.4 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-process` | 2.3.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-updater` | 2.10.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| `@zxing/browser` | 0.2.1 | MIT | https://github.com/zxing-js/browser |
| `ai` | 7.0.26 | Apache-2.0 | https://ai-sdk.dev/docs |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | https://github.com/joe-bell/cva#readme |
| `clsx` | 2.1.1 | MIT | https://www.npmjs.com/package/clsx |
| `cmdk` | 1.1.1 | MIT | https://github.com/pacocoursey/cmdk#readme |
| `codemirror` | 6.0.2 | MIT | https://github.com/codemirror/basic-setup |
| `codemirror-lang-latex` | 0.6.1 | AGPL-3.0-or-later | https://texlyre.github.io/codemirror-lang-latex/ |
| `dockview` | 7.0.4 | MIT | https://github.com/mathuo/dockview |
| `dockview-react` | 7.0.4 | MIT | https://github.com/mathuo/dockview |
| `dompurify` | 3.4.17 | MPL-2.0 OR Apache-2.0 | https://github.com/cure53/DOMPurify |
| `driver.js` | 1.8.0 | MIT | https://driverjs.com |
| `html-to-image` | 1.11.13 | MIT | https://github.com/bubkoo/html-to-image#readme |
| `i18next` | 26.3.6 | MIT | https://www.i18next.com |
| `katex` | 0.18.11 | MIT | https://katex.org |
| `lowlight` | 3.3.0 | MIT | https://www.npmjs.com/package/lowlight |
| `lucide-react` | 1.23.0 | ISC | https://lucide.dev |
| `motion` | 12.42.2 | MIT | https://github.com/motiondivision/motion |
| `nanoid` | 6.0.0 | MIT | https://www.npmjs.com/package/nanoid |
| `next-themes` | 0.4.6 | MIT | https://github.com/pacocoursey/next-themes |
| `onnxruntime-web` | 1.27.0 | MIT | https://github.com/Microsoft/onnxruntime |
| `pdf-lib` | 1.17.1 | MIT | https://pdf-lib.js.org |
| `platejs` | 53.3.14 | MIT | https://platejs.org |
| `qrcode` | 1.5.4 | MIT | http://github.com/soldair/node-qrcode |
| `radix-ui` | 1.6.2 | MIT | https://radix-ui.com/primitives |
| `react` | 19.2.7 | MIT | https://react.dev/ |
| `react-dnd` | 16.0.1 | MIT | https://github.com/react-dnd/react-dnd |
| `react-dnd-touch-backend` | 16.0.1 | MIT | https://github.com/react-dnd/react-dnd |
| `react-dom` | 19.2.7 | MIT | https://react.dev/ |
| `react-i18next` | 17.0.9 | MIT | https://github.com/i18next/react-i18next |
| `react-icons` | 5.7.0 | MIT | https://github.com/react-icons/react-icons#readme |
| `react-resizable-panels` | 4.12.2 | MIT | https://react-resizable-panels.vercel.app/ |
| `remark-directive` | 3.0.1 | MIT | https://www.npmjs.com/package/remark-directive |
| `remark-emoji` | 5.0.2 | MIT | https://github.com/rhysd/remark-emoji#readme |
| `remark-gfm` | 4.0.1 | MIT | https://www.npmjs.com/package/remark-gfm |
| `remark-math` | 6.0.0 | MIT | https://github.com/remarkjs/remark-math/tree/main/packages/remark-math |
| `shiki` | 4.3.1 | MIT | https://github.com/shikijs/shiki#readme |
| `sonner` | 2.0.8 | MIT | https://sonner.emilkowal.ski/ |
| `streamdown` | 2.5.0 | Apache-2.0 | https://streamdown.ai |
| `tailwind-merge` | 3.6.0 | MIT | https://github.com/dcastil/tailwind-merge |
| `tailwindcss` | 4.3.2 | MIT | https://tailwindcss.com |
| `thinking-orbs` | 0.3.1 | MIT | https://orbs.jakubantalik.com |
| `tw-animate-css` | 1.4.0 | MIT | https://github.com/Wombosvideo/tw-animate-css#readme |
| `use-stick-to-bottom` | 1.1.6 | MIT | https://use-stick-to-bottom.samdenty.io |
| `vue` | 3.5.43 | MIT | https://vuejs.org/ |
| `zod` | 4.6.7 | MIT | https://zod.dev |
| `zustand` | 5.0.14 | MIT | https://github.com/pmndrs/zustand |

## 4. Rust 直接依赖

以下为 `src-tauri`、`crates/agentero-core` 与 `cli` 中参与运行时构建的直接依赖（不含 dev-dependencies 与构建脚本依赖）。版本以 `Cargo.lock` 为准。

| Crate | 版本 | 许可证 | 上游 |
| --- | --- | --- | --- |
| `aes` | 0.8.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| `agent-client-protocol` | 1.3.0 | Apache-2.0 | https://github.com/agentclientprotocol/rust-sdk |
| `async-trait` | 0.1.92 | MIT OR Apache-2.0 | https://github.com/dtolnay/async-trait |
| `axum` | 0.8.9 | MIT | https://github.com/tokio-rs/axum |
| `base64` | 0.22.1 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| `bitflags` | 2.13.1 | MIT OR Apache-2.0 | https://github.com/bitflags/bitflags |
| `chrono` | 0.4.45 | MIT OR Apache-2.0 | https://github.com/chronotope/chrono |
| `clap` | 4.6.6 | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `crypto_box` | 0.9.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/nacl-compat/tree/master/crypto_box |
| `dirs` | 6.0.0 | MIT OR Apache-2.0 | https://github.com/soc/dirs-rs |
| `dom_smoothie` | 0.18.0 | MIT | https://github.com/niklak/dom_smoothie |
| `ed25519-dalek` | 2.2.0 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/ed25519-dalek |
| `encoding_rs` | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause | https://github.com/hsivonen/encoding_rs |
| `env_logger` | 0.11.11 | MIT OR Apache-2.0 | https://github.com/rust-cli/env_logger |
| `feed-rs` | 2.4.0 | MIT | https://github.com/feed-rs/feed-rs |
| `flate2` | 1.1.9 | MIT OR Apache-2.0 | https://github.com/rust-lang/flate2-rs |
| `fontdb` | 0.23.0 | MIT | https://github.com/RazrFalcon/fontdb |
| `fs2` | 0.4.3 | MIT/Apache-2.0 | https://github.com/danburkert/fs2-rs |
| `futures-util` | 0.3.33 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| `hex` | 0.4.3 | MIT OR Apache-2.0 | https://github.com/KokaKiwi/rust-hex |
| `htmd` | 0.5.5 | Apache-2.0 | https://github.com/letmutex/htmd |
| `inquire` | 0.7.5 | MIT | https://github.com/mikaelmello/inquire |
| `liteparse` | 2.17.0 | Apache-2.0 | https://github.com/run-llama/liteparse |
| `liteparse-pdfium` | 1.13.0 | Apache-2.0 | https://github.com/run-llama/liteparse |
| `log` | 0.4.33 | MIT OR Apache-2.0 | https://github.com/rust-lang/log |
| `notify-debouncer-full` | 0.3.2 | MIT OR Apache-2.0 | https://github.com/notify-rs/notify |
| `openssh` | 0.11.6 | MIT OR Apache-2.0 | https://github.com/openssh-rust/openssh |
| `openssh-sftp-client` | 0.15.7 | MIT | https://github.com/openssh-rust/openssh-sftp-client |
| `os_info` | 3.15.0 | MIT | https://github.com/stanislav-tkach/os_info |
| `posthog-rs` | 0.23.2 | MIT | https://github.com/posthog/posthog-rs |
| `pulldown-cmark` | 0.13.4 | MIT | https://github.com/raphlinus/pulldown-cmark |
| `reqwest` | 0.12.28 | MIT OR Apache-2.0 | https://github.com/seanmonstar/reqwest |
| `rmcp` | 3.1.4 | Apache-2.0 | https://github.com/modelcontextprotocol/rust-sdk/ |
| `roxmltree` | 0.20.0 | MIT OR Apache-2.0 | https://github.com/RazrFalcon/roxmltree |
| `rusqlite` | 0.32.1 | MIT | https://github.com/rusqlite/rusqlite |
| `rustls` | 0.23.45 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls |
| `schemars` | 1.2.2 | MIT | https://github.com/GREsau/schemars |
| `security-framework` | 3.7.0 | MIT OR Apache-2.0 | https://github.com/kornelski/rust-security-framework |
| `security-framework-sys` | 2.17.0 | MIT OR Apache-2.0 | https://github.com/kornelski/rust-security-framework |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_json` | 1.0.151 | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| `sha2` | 0.11.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| `specta` | 2.0.0-rc.25 | MIT | https://github.com/specta-rs/specta |
| `specta-typescript` | 0.0.12 | MIT | https://github.com/specta-rs/specta |
| `tar` | 0.4.46 | MIT OR Apache-2.0 | https://github.com/composefs/tar-rs |
| `tauri` | 2.11.5 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-plugin-deep-link` | 2.4.9 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-dialog` | 2.7.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-fs` | 2.5.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-log` | 2.9.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-opener` | 2.5.4 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-process` | 2.3.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-shell` | 2.3.5 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-single-instance` | 2.4.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-store` | 2.4.4 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-updater` | 2.10.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-window-state` | 2.4.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-specta` | 2.0.0-rc.25 | MIT | https://github.com/specta-rs/tauri-specta |
| `tempfile` | 3.27.0 | MIT OR Apache-2.0 | https://github.com/Stebalien/tempfile |
| `thiserror` | 2.0.20 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| `tokio` | 1.53.1 | MIT | https://github.com/tokio-rs/tokio |
| `tokio-tungstenite` | 0.26.2 | MIT | https://github.com/snapview/tokio-tungstenite |
| `tokio-util` | 0.7.19 | MIT | https://github.com/tokio-rs/tokio |
| `toml` | 0.8.2 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `url` | 2.5.8 | MIT OR Apache-2.0 | https://github.com/servo/rust-url |
| `urlencoding` | 2.1.3 | MIT | https://github.com/kornelski/rust_urlencoding |
| `uuid` | 1.24.0 | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| `walkdir` | 2.5.0 | Unlicense/MIT | https://github.com/BurntSushi/walkdir |
| `webview2-com` | 0.38.2 | MIT | https://github.com/wravery/webview2-rs |
| `which` | 7.0.3 | MIT | https://github.com/harryfei/which-rs |
| `windows` | 0.61.3 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `winreg` | 0.55.0 | MIT | https://github.com/gentoo90/winreg-rs |
| `zip` | 2.4.2 | MIT | https://github.com/zip-rs/zip2 |
| `zstd` | 0.13.3 | MIT | https://github.com/gyscos/zstd-rs |

## 5. 需要特别说明的许可证

### 5.1 AGPL-3.0-or-later

`codemirror-lang-latex` 0.6.1 以 **AGPL-3.0-or-later** 发布，用于 Markdown 编辑器的 LaTeX 语法高亮。其完整源码与许可证见上游仓库：<https://github.com/texlyre/codemirror-lang-latex>。

Agentero 以 MIT 许可证分发。分发该组件（无论是否修改）时均需遵守 AGPL 的源码提供义务；若修改后作为网络服务提供，还需向网络用户提供对应源码。维护者应在每次发行前复核该依赖的合规性；如后续替换为兼容许可证的实现，请同步更新本节。

### 5.2 MPL-2.0

以下组件以 MPL-2.0 发布（部分为双许可证）：

| 组件 | 使用方式 | 说明 |
| --- | --- | --- |
| `dompurify` | 运行时（前端） | `MPL-2.0 OR Apache-2.0`，本项目按 Apache-2.0 使用 |
| `resvg` / `usvg` / `cssparser` / `selectors` | 运行时（经 `liteparse` 间接引入） | MPL-2.0；未修改上游源码 |
| `lightningcss` | 构建期 | MPL-2.0；不随发行物分发 |

MPL-2.0 是文件级 copyleft：使用未修改的上游文件不要求开源本项目，但分发时需保留许可证与源码获取方式。上游源码可通过上表链接获取。

### 5.3 OFL-1.1（字体）

`@fontsource-variable/geist` 与 EmbedPDF 的 `@embedpdf/fonts-*` 使用 SIL Open Font License 1.1。字体文件可以随应用分发，但不得单独售卖，也不得使用上游保留字体名称发布修改版。许可证全文见 <https://openfontlicense.org/>。

### 5.4 Apache-2.0

大量组件使用 Apache-2.0，包括 Tauri、ONNX Runtime、Tesseract、`liteparse`、`rmcp`、`ai`、`streamdown` 与部分 ACP Adapter。分发时应保留版权声明、许可证副本与上游 `NOTICE` 文件（如有）。许可证全文见 <https://www.apache.org/licenses/LICENSE-2.0>。

### 5.5 BSD-3-Clause / BSD-2-Clause

PDFium、`ed25519-dalek`、`encoding_rs` 使用 BSD-3-Clause；Leptonica 使用 BSD-2-Clause。分发二进制时需在文档或关于页面中保留版权声明、条件与免责声明。

## 6. 如何获取完整依赖清单

本项目不手工维护全部传递依赖。需要审计时，请使用锁文件与包管理器生成：

```bash
# 前端生产依赖（名称、版本、许可证）
pnpm licenses list --prod

# Rust 依赖（名称、版本、许可证、来源）
cargo metadata --format-version 1

# 内置 ACP Adapter 的依赖树
find src-tauri/adapters/node_modules -maxdepth 3 -name package.json
```

GitHub 也会根据 `pnpm-lock.yaml` 与 `Cargo.lock` 自动生成依赖图，可在仓库的 **Insights → Dependency graph** 中查看。

## 7. 更正与咨询

如果发现遗漏、版本不一致或许可证标注错误，欢迎提交 Issue：<https://github.com/poco-ai/Agentero/issues>。

本文件不构成法律意见。对外分发二进制前，建议由维护者或法务确认许可证义务是否满足（尤其是 AGPL-3.0-or-later 与 MPL-2.0 组件）。
