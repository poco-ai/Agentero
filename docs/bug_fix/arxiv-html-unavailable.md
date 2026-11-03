# arXiv HTML 被显示成 arXiv unavailable

2026-11-03。点论文的 HTML 按钮后，页面只有一行 `arXiv unavailable`；有时又能打开，但要等很久。

## 根因

HTML 地址总是拼成 `https://arxiv.org/html/{id}`，再经 `agentero-arxiv` 代理整页拉下来。代理把断线、超时和连接失败都写成同一句 `arXiv unavailable`。arXiv 在没有 HTML 时返回的是 404，不是这句。样式、脚本和图片的根路径也进了这条代理，要等正文下完才开始，所以能打开时也很慢。

## 修复

阅读器在页面里直接请求 arXiv。200 且正文是 HTML 才嵌入，并用 `<base>` 让 `/static` 和相对图片走 arXiv 自己的地址。404 视为还没有 HTML；传输失败单独提示，并重试一次卡住的连接。失败后可以回到 PDF，或打开摘要。同一篇成功过的 HTML 留在内存里，再次打开不再请求。
