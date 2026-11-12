# 机构代理网关

付费文献 PDF 兜底：当直连、候选链接与 Unpaywall 都未命中时，用**用户自己的学校账号会话**，把目标 URL 重写成学校网关可识别的形式再请求。桌面端与 headless CLI 共用同一份 `settings.json`。

代码边界：`crates/agentero-core/src/features/paper/import/institution_proxy/`。应用侧的设置页、登录窗口、文件落盘不放在该模块内。

## 四种类型

| 类型 | 请求形态 | 会话 | 典型入口 | 注意 |
| --- | --- | --- | --- | --- |
| `auto` | 不重写，先识别再落到下面三种 | 同目标类型 | 任意自定义地址 | 只是分类开关，不是协议 |
| `ezproxy` | `{prefix}{urlencode(target)}`，裸域自动补 `/login?url=` | 网关 Cookie | 标准 EZProxy | 依赖学校配置的登录入口；部分学校自建系统会伪装成 EZProxy 名称 |
| `wengine` | `{gateway}/https/{AES-128-CTR(host)}/{path}` | 网关 Cookie | 浙大、中科大、西交、东北大学、清华、复旦 | 路径被网关重写，query 不随路径保留；资源范围由学校网关决定 |
| `subdomain` | `{scheme}://{host 点换横线}-{port}.{gateway}/{path}?{query}` | 网关会话 + 每个目标子域单独换发的 token | 北大医学部（Astraeus） | 首次请求常经 `/vpn_key/update` 换 token；Cookie 必须随重定向带过去 |

`auto` 的判定顺序：

1. 地址本身带 `/login?url=` 或路径以 `/login` 结尾 → `ezproxy`。
2. 网关根指纹：`wengine_vpn_ticket` → `wengine`；`_astraeus_session`、`_webvpn_key`、`/users/sign_in`、`/vpn_key/` → `subdomain`。
3. 请求子域映射后的 host：只有支持子域映射的网关能解析。
4. 请求 wengine 路径：非 wengine 通常返回 400/404。
5. 请求 EZProxy 查询形式：其余情况下的兜底。

检测结果按前缀缓存在进程内，同一进程内的批量导入不会重复识别。识别失败时设置页会提示手动选择类型。

## 三个状态必须分开

机构入口有三件互相独立的事：

| 状态 | 含义 | 是否等于能下载 |
| --- | --- | --- |
| 入口存在 | 地址能打开，有登录页 | 否 |
| 协议兼容 | 能用上述重写规则发出请求，入口指纹匹配 | 否，仍需学校订阅 |
| 订阅已验证 | 用授权账号实际下载到该刊 PDF | 是 |

预设只声明前两项。`presets.json` 里的 `protocolVerifiedAt` 是入口指纹日期，`subscriptionVerified` 只有在授权账号完成 PDF 下载后才置为 `true`。仅验证登录页可打开不算通过。

## 预设注册表

数据文件：`crates/agentero-core/src/features/paper/import/institution_proxy/presets.json`。

字段：

```json
{
  "id": "bjmu",
  "prefix": "https://webvpn.bjmu.edu.cn",
  "kind": "subdomain",
  "protocolVerifiedAt": "2026-11-09",
  "subscriptionVerified": false
}
```

- `kind` 只能是 `ezproxy` / `wengine` / `subdomain`，不能是 `auto`。
- `protocolVerifiedAt` 记录入口指纹日期；`subscriptionVerified` 只有在授权账号实际下载到 PDF 后才置为 `true`。
- 范围限制与验证依据留在本文和 issue 中，不塞进注册表。
- 新增学校：改 JSON，补 `general.institutionProxy.presets.{id}` 的中英文名称即可；类型和地址由 Host 通过 `institution_proxy_presets` 命令下发给设置页。
- 地址必须是 HTTPS 网关源站；不要带目标路径或查询。

## 当前覆盖与未覆盖

已进入注册表：

- wengine：浙大、中科大（`wvpn.ustc.edu.cn`）、西交、东北大学、清华（`webvpn.tsinghua.edu.cn`）、复旦（`webvpn.fudan.edu.cn`）。
- subdomain：北大医学部（`webvpn.bjmu.edu.cn`）。

以下入口**不能只靠加地址**支持，仍需要新适配器或走系统 VPN：

| 入口 | 模型 | 为什么不能直接加 |
| --- | --- | --- |
| 清华 `eproxy.lib.tsinghua.edu.cn` | 自建 OpenURL 网关（`/openurl*`、`/sso`） | 是解析器，不是 URL 前缀重写 |
| 北大 `wpn.pku.edu.cn` | 隧道 / 校内 | 校外 TLS 不可达，属于网络隧道 |
| 北大 `arrayvpn.pku.edu.cn` | Array `/prx/000/http/{host}/{path}` | 是另一种路径式重写，需单独实现并验证 `ANbookmark` 会话 |
| 南大 `vpn.nju.edu.cn` / 哈工大 `ivpn.hit.edu.cn` | aTrust `/portal/` | 门户 + 客户端隧道，Web 重写规则未知 |
| 上交 `sslvpn.sjtu.edu.cn` | 深信服 / Sangine 门户 | 有 Web 门户不代表能代理出版商；优先验证客户端 / IKEv2 后的正常下载链 |

## 探测与健康检查

- 设置页“测试”调用 `institution_proxy_probe`，用 `10.1038/nature12373` 实际请求一次 PDF。
- 结果会区分“跳转登录”（`institution_proxy_auth_required`）与“返回 HTML 但不是 PDF”。后者可能是未订阅，也可能是网关没把 PDF 暴露出来，不能直接等同于 Cookie 过期。
- 打开独立登录窗口后，Host 每 2 秒检查网关 Cookie；新 Cookie 通过上述 PDF 探测后才保存并关窗。
- 桌面端每天最多自动探测一次已配置凭据，明确认证失效时 Toast 提醒。
- CLI 启动时读取同一份 `settings.json`，`import id` / `paper download` 使用相同的网关、Cookie 与自动检测逻辑。

## 相关

- 设置字段与默认值：[settings.md](settings.md)
- 学术检索与下载链中的数据流：[academic-search-apis.md](academic-search-apis.md)
- 学校适配缺口跟踪：[#848](https://github.com/poco-ai/Agentero/issues/848)
