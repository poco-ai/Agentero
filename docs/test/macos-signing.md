# macOS Developer ID 签名与公证（Notarization）

> 目标：店外分发（GitHub Release / 官网）时，用户下载后 **不再出现「已损坏 / 无法验证开发者」**。  
> 路径：**Developer ID Application** 签名 + **notarytool** 公证 + **stapler** 装订。  
> 这与 **Mac App Store 上架** 不是同一条链路（MAS 强制 App Sandbox，需另配）。

未配置 secrets 时，CI **仍会打未签名包**（与历史行为一致），仅打 warning。本地 `pnpm tauri dev` **不依赖** 这些凭据。

签名与公证由 **Tauri CLI + CI 环境变量** 完成，仓库内不维护专用脚本。

## 总览：要去哪、拿什么

| 步骤 | 去哪里 | 下载/得到什么 | 干什么 |
|------|--------|---------------|--------|
| 1 | 本机「钥匙串访问」 | CSR 文件 | 向 Apple 申请证书 |
| 2 | [Apple Developer → Certificates](https://developer.apple.com/account/resources/certificates/list) | **Developer ID Application** 的 `.cer` | 装进钥匙串，用于 **codesign** |
| 3 | 本机钥匙串 | `.p12` + base64 | 填进 GitHub Secrets，给 CI 签名 |
| 4 | [App Store Connect → API](https://appstoreconnect.apple.com/access/integrations/api) | Issuer ID、Key ID、`.p8` 私钥 | 给 **notarytool** 公证 |
| 5 | [GitHub Secrets](https://github.com/poco-ai/Agentero/settings/secrets/actions) | 无下载 | 粘贴上面得到的值 |
| 6（可选） | 本机终端 | 无 | 导出环境变量后 `pnpm tauri build` 验证 |

**不必**在 App Store Connect 里创建 Mac App 记录——那是上架用的；店外公证只用 **API Key + Developer ID**。

---

## 第一步：本机生成 CSR（不下载，自己生成）

1. 打开 **钥匙串访问**（Keychain Access）。  
2. 菜单：**钥匙串访问 → 证书助理 → 从证书颁发机构请求证书…**  
3. 填邮箱、常用名称；选 **存储到磁盘**。  
4. 得到类似 `CertificateSigningRequest.certSigningRequest` 的文件。  

后面在 Developer 网站 **上传这个 CSR**。

---

## 第二步：下载 Developer ID 证书（签名用）

**地址：** <https://developer.apple.com/account/resources/certificates/list>

1. 登录（需 [Apple Developer Program](https://developer.apple.com/programs/)，约 $99/年）。  
2. 点 **+** 新建证书。  
3. 类型选：**Developer ID Application**  
   - **不要**选 Apple Development  
   - **不要**选 Apple Distribution（上架 / MAS 用）  
4. 上传第一步的 CSR。  
5. **Download** 得到 `.cer`。  
6. **双击 `.cer`**，装入 **login** 钥匙串。  

**本机确认：**

```bash
security find-identity -v -p codesigning
```

应出现一行类似：

```text
"Developer ID Application: 你的名字 (TEAMID)"
```

若只有 `Apple Development: …`，说明本步未完成，**还不能**做店外分发签名。  
**只有账号的 Account Holder 才能创建 Developer ID Application 证书。**

---

## 第三步：导出 `.p12` 并生成 base64（给 CI）

1. 打开 **钥匙串访问** → **登录** → **我的证书**。  
2. 展开 **Developer ID Application: …**，选中下方 **私钥**。  
3. 右键 → **导出…** → 格式 **个人信息交换 (.p12)**，设密码（即 `APPLE_CERTIFICATE_PASSWORD`）。  
4. 终端转 base64（一行）：

```bash
openssl base64 -A -in /path/to/certificate.p12 -out certificate-base64.txt
# APPLE_CERTIFICATE = certificate-base64.txt 的全文
# APPLE_SIGNING_IDENTITY = security find-identity 里那一整串名字
```

**不要**把 `.p12` / base64 提交进 git。Secrets 填完后删除本地导出文件。

---

## 第四步：下载公证用的 API Key（notarytool）

**地址：** <https://appstoreconnect.apple.com/access/integrations/api>  

路径：**用户和访问 → 集成 → App Store Connect API**

1. 点 **生成 API 密钥**（或 **+**）。  
2. 名称随意；访问权限至少 **开发者 / Developer**。  
3. 页面上记下来：  
   - **Issuer ID**（密钥表格上方）  
   - **Key ID**（表格中的一列）  
4. 点 **下载** → 得到 `AuthKey_XXXXXXXXXX.p8`  
   - **只能下载一次**，立刻保存。  

建议：

```bash
mkdir -p ~/private_keys
mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/private_keys/
```

| 东西 | 对应 Secret / 环境变量 |
|------|------------------------|
| Issuer ID | `APPLE_API_ISSUER` |
| Key ID | `APPLE_API_KEY` |
| `.p8` 全文 | GitHub：`APPLE_API_KEY_P8`；本地：`APPLE_API_KEY_PATH` |

**备选（不用 API Key 时）：** Apple ID + [App 专用密码](https://support.apple.com/102654) + [Team ID](https://developer.apple.com/account#MembershipDetailsCard) → Secrets `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`。

---

## 第五步：填到 GitHub Secrets（无下载，粘贴）

**本仓库地址：**  
<https://github.com/poco-ai/Agentero/settings/secrets/actions>  

路径：**Settings → Secrets and variables → Actions → New repository secret**

| Secret 名 | 从哪来 |
|-----------|--------|
| `APPLE_CERTIFICATE` | `certificate-base64.txt` 全文（一行 base64） |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect Issuer ID |
| `APPLE_API_KEY` | App Store Connect Key ID |
| `APPLE_API_KEY_P8` | `.p8` 文件内容（整段 PEM，或 base64） |

填完后，推送 `v*` tag 时，`.github/workflows/release.yml` 的 macOS job 会：

1. 写入 API key 文件（若配置了 `APPLE_API_KEY_P8`）  
2. `tauri-action` 用 `APPLE_CERTIFICATE*` **codesign（Developer ID）**  
3. 有公证凭据时自动 **notarytool 提交 + 等待 + staple**  

Linux / Windows job 不受影响。

---

## 第六步（可选）：本机验证

钥匙串里已有 Developer ID 时：

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: 你的名字 (TEAMID)"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export APPLE_API_KEY="XXXXXXXXXX"
export APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_${APPLE_API_KEY}.p8"

pnpm tauri build
```

或 CI 式 `.p12` 导入：再设 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`。

校验产物：

```bash
APP=target/release/bundle/macos/Agentero.app
codesign --verify --strict --verbose=2 "$APP/Contents/MacOS/agentero-turn"
codesign --display --verbose=4 "$APP/Contents/MacOS/agentero-turn"   # Developer ID Application / runtime
codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"
```

仅签名、跳过 staple：

```bash
pnpm tauri build -- --skip-stapling
```

产物一般在：

```text
target/release/bundle/macos/Agentero.app
target/release/bundle/dmg/…
```

---

## 工程侧已接好的内容

| 项目 | 说明 |
|------|------|
| Bundle ID | `com.poco-ai.agentero`（`src-tauri/tauri.conf.json` → `identifier`） |
| Entitlements | `src-tauri/Entitlements.plist`（Hardened Runtime：JIT 等；**无** App Sandbox） |
| Info.plist | `src-tauri/Info.plist`（`ITSAppUsesNonExemptEncryption=false`） |
| 最低系统 | macOS 12.0（`bundle.macOS.minimumSystemVersion`） |
| CI | `.github/workflows/release.yml` macOS job 读取上表 secrets |

`signingIdentity` **不写死在仓库**，由环境变量 / Secrets 注入。

### Tauri 环境变量摘要

| 用途 | 变量 |
|------|------|
| 签名（本地钥匙串） | `APPLE_SIGNING_IDENTITY` |
| 签名（CI `.p12`） | `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` |
| 公证（推荐） | `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`（CI 由 workflow 写出） |
| 公证（备选） | `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` |

官方说明：[Tauri macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)。

### 安全约定

- 证书、`.p12`、`.p8`、App 专用密码 **永不进 git**  
- secrets 未配置时不阻断 Linux / Windows 发布  

---

## 常见问题

| 现象 | 处理 |
|------|------|
| `security find-identity` 只有 Apple Development | 完成 **第二步**：创建 Developer ID Application |
| 无法创建 Developer ID | 确认是否为 **Account Holder** |
| 公证 Invalid / 7000 | 新团队可能需联系 Apple 开通 notarization；查 submission log |
| `spctl` 仍拒 | 是否 staple；是否签成了 Development 而非 Developer ID |
| CI 未签名 | 检查 `APPLE_CERTIFICATE`；看 workflow warning |
| 公证超时 | notary 偶发排队；重跑 job |
| 签名后 BYOA 异常 | 检查 `Entitlements.plist` 中 library-validation / JIT |

---

## 检查清单

- [ ] Developer Program 有效  
- [ ] 第一步 CSR 已生成  
- [ ] 第二步 Developer ID Application `.cer` 已装入 login 钥匙串  
- [ ] `security find-identity` 能看到 `Developer ID Application: …`  
- [ ] 第三步 `.p12` / base64 已导出  
- [ ] 第四步 API Key（Issuer / Key ID / `.p8`）已保存  
- [ ] 第五步 [GitHub Secrets](https://github.com/poco-ai/Agentero/settings/secrets/actions) 六项已填  
- [ ] （可选）第六步本机 `pnpm tauri build` + `codesign` / `spctl` 通过  
- [ ] 推送 `vX.Y.Z` tag，Release 中 macOS 产物已签名且可直接打开  

---

## 相关文件

- `src-tauri/Entitlements.plist`  
- `src-tauri/Info.plist`  
- `src-tauri/tauri.conf.json`  
- `.github/workflows/release.yml`  
- [`release.md`](release.md)（版本 bump / tag 流程）  
