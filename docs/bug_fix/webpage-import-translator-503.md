# 网页导入被翻译服务 503 挡住

翻译服务返回 HTTP 503（Cloudflare `error code: 1102`，Worker 资源上限）时，没有 DOI、arXiv ID 或 PMID 的网页会整段失败，提示 `no identifier matched the direct-connect fallback chains`。

## 修复

网页导入不再依赖翻译服务成功。

1. HTTP 503 和正文里的 `error code: 1102` 分类为 `service_unavailable`。同一次翻译请求再试两次（400ms、800ms），仍失败就放弃这次调用。
2. 输入里有 DOI / arXiv / PMID 时，仍走原来的直连链。
3. `http(s)` URL 没有这些标识符，或直连链也失败时，抓取原网页。论文页读取 `citation_*`；页内 DOI 再试一次直连链。普通网页用 URL、标题和 `og:` / `<title>` 建 `html` 条目。页面抓不到时只保存 URL。
4. 成功降级写入 `translator_degraded|状态|错误码|page|服务地址`（或 `url_only`），界面提示翻译服务不可用但条目已导入。不是网页、也没有标识符时返回 `translator_unavailable`，文案带 HTTP 状态和错误码。日志目标是 `agentero::lookup`。
