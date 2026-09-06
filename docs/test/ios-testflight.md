# iOS TestFlight Release

## GitHub Actions (recommended)

`.github/workflows/ios-testflight.yml` builds a signed IPA and uploads it to
App Store Connect. It runs on `v*` tag pushes (alongside the desktop Release
workflow) and can be triggered manually from the Actions tab.

When the signing secrets are not configured, an automatic tag run exits
successfully with a warning and skips the iOS build. A manually triggered run
still fails during preflight so missing release configuration is explicit.

Required secrets (org or repo level):

| Secret | Content |
|---|---|
| `APPLE_DISTRIBUTION_CERTIFICATE` | Apple Distribution `.p12`, base64 |
| `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD` | `.p12` export password |
| `IOS_MOBILE_PROVISION` | App Store provisioning profile, base64 |
| `APPLE_API_KEY` / `APPLE_API_KEY_P8` / `APPLE_API_ISSUER` | App Store Connect API key (shared with the macOS notarization flow) |
| `APPLE_TEAM_ID` or `APPLE_SIGNING_IDENTITY` | Team ID, or an identity string ending in `(TEAMID)` |

The build number is a `yymmddHHMM` timestamp, so each run produces a strictly
increasing build for the same version.

## New Machine Setup

iOS builds require macOS, Xcode, Node.js, pnpm, and the stable Rust toolchain.
After cloning the repository, initialize the local Tauri project:

```bash
pnpm install
rustup target add aarch64-apple-ios-sim
pnpm tauri ios init
```

The committed sources of truth are `src-tauri/ios-project.yml`,
`src-tauri/tauri.ios.conf.json`, and `src-tauri/Info.ios.plist`.
`src-tauri/gen/apple/` is generated locally by Tauri and should not contain
machine-specific `libapp.a`, Xcode scheme, or developer-team changes in a
commit.

## Repository checks

Run these before creating an archive:

```bash
pnpm ios:release:check
pnpm build
RUSTUP_CARGO="$(rustup which --toolchain stable-aarch64-apple-darwin cargo)"
RUSTUP_RUSTC="$(rustup which --toolchain stable-aarch64-apple-darwin rustc)"
PATH="$(dirname "$RUSTUP_CARGO"):$PATH" RUSTC="$RUSTUP_RUSTC" CARGO_TARGET_DIR=target-ios \
  "$RUSTUP_CARGO" clippy --manifest-path src-tauri/Cargo.toml \
  -p agentero --target aarch64-apple-ios-sim --lib -- -D warnings
```

The Rustup paths are intentional: this workstation also has a Homebrew Rust
toolchain, and Cargo artifacts must not be shared across the two toolchains.

The mobile app requires iOS 15 or later and supports both iPhone and iPad. The
camera permission is requested only after the user selects QR pairing. Pairing
messages and Vault data are encrypted end to end; the Relay receives routing
metadata and opaque frames only.

## Apple Account Setup

1. In Certificates, Identifiers & Profiles, create the `com.poco-ai.agentero`
   App ID and enable the capabilities actually used by the build.
2. Install an Apple Development certificate for device testing and an Apple
   Distribution certificate plus App Store provisioning profile for TestFlight.
3. Set the team ID locally, without committing it:

```bash
export APPLE_DEVELOPMENT_TEAM="YOUR_TEAM_ID"
```

4. Create the app record in App Store Connect with the same bundle ID and
   category. Increment the build number for every upload.

## Archive And Upload

Create a signed TestFlight archive after a clean release build:

```bash
APPLE_DEVELOPMENT_TEAM="$APPLE_DEVELOPMENT_TEAM" \
  pnpm tauri ios build --config src-tauri/tauri.ios.conf.json \
  --target aarch64 --build-number "$(date +%y%m%d%H%M)" \
  --export-method app-store-connect
```

The build number must fit in a 32-bit unsigned integer, so the timestamp uses a
two-digit year.

Upload the generated IPA through Xcode Organizer or Transporter if the CLI does
not upload it as part of the selected export flow.

## App Store Connect Checklist

- Add a public privacy policy URL and complete the App Privacy questionnaire.
  Relay traffic, any configured Agent provider, and all third-party SDKs must
  be represented accurately.
- Complete export-compliance questions. Agentero uses standard TLS plus
  X25519/XSalsa20-Poly1305 and Ed25519 for the remote pairing protocol; do not
  claim the build is exempt without confirming the App Store Connect answers.
- Fill **App Review Information** per
  [Beta review: no login, no fake test page](#beta-review-no-login-no-fake-test-page)
  (Sign-in required = No; paste pairing Notes; no demo username/password).
- Add beta review contact information and test iPhone and iPad builds before
  inviting external testers.

Apple requires a camera usage description when an app accesses the camera, and
requires a privacy policy URL and accurate app privacy disclosures. See
[camera usage description](https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription),
[app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/),
and [upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/).

## Beta review: no login, no fake test page

Agentero iOS has **no accounts and no in-app sign-in**. Do not invent a login
screen, a “reviewer password”, or a website where Apple must enter credentials
just to pass review. That is the wrong fix for a no-account app.

### What to put in App Store Connect

| Field | Value |
|---|---|
| **Sign-in required** | **No** |
| **Demo account (username / password)** | **None** — leave blank |
| **App Review Notes** | **Required** — how to pair with a desktop Host (English block below) |
| **Contact email / phone** | Real contact during Beta and full App Review |

A **TestFlight invite link** (for human testers) is unrelated to “demo login”.
Internal testers need the invite; Apple reviewers need Notes, not a fake login
URL.

### Why Notes matter (not a test login page)

The iOS app is a **remote client**: without a paired desktop Vault it stays on
the Connect screen by design. Reviewers care whether they can reach Library /
PDF / Notes / Agent — not whether a username exists.

Provide **App Review Notes** that explain:

1. Install desktop Agentero and open a Vault
   (`https://agentero.poco-ai.com`).
2. Enable Bridge (Settings → Remote Access → Start); keep the QR / 6-digit
   code visible.
3. On iOS: Scan QR, or paste a pairing link (`agentero://pair#offer=...`).
4. Confirm the code; then exercise Library → PDF / Notes → Agent over
   `wss://relay.philfan.cn`.

Paste the full English **App Review notes** block under
[App Store Connect Metadata](#app-store-connect-metadata). Keep the same
English Notes for every localization.

### Optional: help reviewers finish pairing

If you worry reviewers have no desktop:

- Keep a **demo desktop + Bridge** online during review, and put contact info
  in App Review Information so they can schedule pairing help; and/or
- Offer a **time-limited pairing link** (revocable) in Notes, with step-by-step
  paste instructions.

Still **not** a fake in-app login page. A later product choice of a limited
**offline demo vault** (read-only sample content without desktop) is optional
and separate — only consider it if review fails under Guideline 2.1 because
core flows cannot be verified without pairing.

### TestFlight vs App Store review

| Stage | Apple review of the build? | Demo account? | What you prepare |
|---|---|---|---|
| **Internal TestFlight** | No (same developer team) | No | Invite internal testers; smoke-test Connect → Library → PDF/Notes → Agent |
| **External TestFlight** | Yes (Beta App Review) | No | Same Sign-in = No + pairing Notes; beta contact info |
| **App Store version** | Yes (full App Review) | No | Same fields + privacy, screenshots, export compliance, etc. |

Ensure `relay.philfan.cn` (or the relay named in Notes) is up for the whole
review window.

## App Store Connect Metadata

Ready-to-paste copy for the App Store Connect review form. English is the
primary localization; the Chinese block goes into a separate `zh-CN`
App Store localization added on top of the English one. URLs and field
names are not translated.

### English (primary localization)

**App name:** `Agentero`
**Subtitle (≤30 chars):** `Local-first research vault` (26)
**Primary language:** English
**Category (Primary / Secondary):** Productivity / Education

**Promotional text (≤170 chars, 169):**

```
Agentero pairs your iPhone with a desktop research vault. Read PDFs, write notes, and chat with your own ACP Agent — end-to-end encrypted through your self-hosted relay.
```

**Description:**

```
Agentero is a local-first research workbench for individual researchers
and the Agents they collaborate with. The iOS app is a remote client for
the desktop Agentero: it lets you carry your literature library, PDF
notes, and Agent conversations in your pocket — without moving your
Vault off your own computer.

PAIR WITH YOUR DESKTOP
Scan a QR code or paste a pairing link to connect over an end-to-end
encrypted relay (X25519 + XSalsa20-Poly1305, Ed25519 device key). All
files, the catalog, and the ACP Agent stay on your desktop; the phone
renders and caches.

READ YOUR LIBRARY ON THE GO
Browse the desktop's paper library with full-text search. Open any
paper to read the PDF side-by-side with its notes, or toggle to the
NOTES.md editor and write back to the desktop.

CHAT WITH YOUR OWN AGENT
Use the Agent tab to talk to the ACP Agent you already have installed
on your computer — Claude, Codex, OpenCode, Antigravity, Qoder, Grok, or
any ACP-compatible CLI. Streaming replies, history, and permission
prompts are forwarded from the desktop.

BUILT FOR PRIVACY
No accounts, no analytics, no telemetry. Pairing credentials live in
iOS Keychain. The relay only sees opaque encrypted frames.

COMING FROM THE DESKTOP
Agentero is a Tauri 2 + React 19 local-first research workbench with
BYOA Agent support, Zotero-compatible import, Obsidian-style wikilinks,
WYSIWYG Markdown, in-place translation, and SSH remote Vaults. The
desktop builds are MIT-licensed and ship for macOS, Windows, and Linux.

Requirements
• iOS 15.0 or later
• An Agentero desktop install on macOS, Windows, or Linux
  (agentero.poco-ai.com)
• An ACP-compatible Agent installed on the desktop for the Agent tab
```

**Keywords (≤100 chars, comma-separated):**

```
research,vault,papers,PDF,notes,agent,markdown,obsidian,bibliography,academic
```

**What's new in this version (0.3.2):**

```
• Initial TestFlight release.
• iPhone and iPad support, iOS 15.0+.
• Pair with desktop Agentero over an end-to-end encrypted relay.
• Read desktop library, PDFs, and notes; write notes back.
• Streamed chat with the desktop's ACP Agent.
```

**Support URL:** `https://agentero.poco-ai.com/usage/`
**Marketing URL:** `https://github.com/poco-ai/agentero`
**Privacy policy URL:** `https://agentero.poco-ai.com/privacy/` (must
exist before the version can be submitted for review).

**Sign-in required:** No  
**Demo account:** None (leave username and password empty — the app has no
login; do not create a dummy account form for review)

**App Review notes (paste verbatim):**

```
Agentero iOS is a remote client for a desktop Agentero Vault — it
cannot create or open a Vault on the device. To exercise the app, a
reviewer needs:

1. macOS, Windows, or Linux desktop with Agentero installed and a
   Vault opened (download: https://agentero.poco-ai.com).
2. The desktop Bridge enabled (Settings → Remote Access → Start). The
   desktop will show a QR code and a 6-digit pairing code.
3. On the iOS app, tap "Scan QR code" and point at the desktop's QR.
   Confirm the 6-digit code matches.
4. Once paired, the Library, PDF, and Notes panels render the
   desktop's content over an end-to-end encrypted relay at
   wss://relay.philfan.cn.

Without a desktop, the iOS app shows the Connect screen and cannot be
tested further — this is by design. A sandbox TestFlight review build
on the App Store reviewer's iPhone will work the same way.

Network egress: the iOS app only contacts wss://relay.philfan.cn:443.
The relay routes opaque X25519+XSalsa20-Poly1305 frames; it does not
decrypt Vault or Agent content.

Permissions requested: Camera (NSCameraUsageDescription) — only when
the user taps "Scan QR code"; a manual paste fallback is offered. No
microphone, photos, location, contacts, or background modes are used.
```

**Export compliance:** uses standard TLS plus X25519 ECDH,
XSalsa20-Poly1305 symmetric encryption, and Ed25519 device-key
signatures. Standard commercial cryptography — qualifies for the
Category 5 Part 2 self-classification exemption; no CCATS required.

**Age rating:** 16+. No violence, no UGC, no ads, no gambling, no profanity. Research content may include peer-reviewed material with medical / scientific imagery and adult-topic citations, so the conservative 16+ tier is selected.

**App Privacy (questionnaire summary):** all 14 data categories →
"Data Not Collected", including User Content (Notes) — the iOS app
caches PDF pages and notes locally and routes them through the
end-to-end encrypted relay between the device and the user's own
computer; nothing is uploaded to Apple. `NSLocalNetworkUsageDescription`
is declared but only used by `pnpm tauri ios dev` over
`http://localhost:1420`; it is not used in the production App Store
build.

**Future collection (roadmap, not in this submission):** a later
release may add on-device crash logs and anonymous usage telemetry,
used solely to diagnose issues and improve app stability. This data
will not be used for advertising, user profiling, or third-party
sharing, and the privacy policy will be updated before collection is
enabled. The App Privacy answers above reflect the current submission
only and will be revised in the release that introduces collection.

### Chinese (zh-CN localization)

Add under Versions → App Store Localizations → "Chinese (Simplified)"
once the English version is in. Reuse the same Support, Marketing, and
Privacy URLs and the same App Privacy answers as English — privacy
questionnaire answers are language-independent.

**App name:** `Agentero`
**Subtitle (≤30 chars):** `本地优先科研知识库` (9)
**Category (Primary / Secondary):** 效率 / 教育

**Promotional text (≤170 chars):**

```
Agentero 让 iPhone 配对你的桌面科研 Vault。浏览论文库、分屏阅读
PDF 与笔记、与你自己的 ACP Agent 对话——全程经自建中继端到端加密。
```

**Description:**

```
Agentero 是为独立科研工作者和他们协作的 Agent 设计的本地优先
科研工作台。iOS 应用是桌面 Agentero 的远程客户端：把论文库、
PDF 笔记和 Agent 对话装进口袋，Vault 不离开你自己的电脑。

配对你的桌面
扫描二维码或粘贴配对链接，通过端到端加密的中继完成连接
（X25519 + XSalsa20-Poly1305，Ed25519 设备密钥）。所有文件、
catalog 和 ACP Agent 都留在你的桌面上；手机只负责渲染和缓存。

随时随地读你的文献库
浏览桌面论文库并全文搜索。打开任意论文即可分屏阅读 PDF 与
笔记，或切换到 NOTES.md 编辑器写回桌面。

与自己的 Agent 对话
用 Agent 标签页和你已经在电脑上安装的 ACP Agent 聊天——
Claude、Codex、OpenCode、Antigravity、Qoder、Grok 或任意兼容 ACP
的 CLI。流式回复、历史会话和权限确认都由桌面转发过来。

为隐私而生
没有账号、没有分析、没有埋点。配对凭据存于 iOS Keychain。
中继只看到不透明的加密帧。

桌面端的延伸
Agentero 是基于 Tauri 2 + React 19 的本地优先科研工作台，支持
BYOA Agent、Zotero 兼容导入、Obsidian 风格双链、所见即所得
Markdown、就地翻译和 SSH 远程 Vault。桌面端为 MIT 协议，发布
于 macOS、Windows 和 Linux。

要求
• iOS 15.0 或更高版本
• 桌面端（macOS、Windows 或 Linux）已安装 Agentero
  （agentero.poco-ai.com）
• Agent 标签页需要在桌面端安装 ACP 兼容的 Agent
```

**Keywords (≤100 chars):**

```
科研,论文库,PDF,笔记,Agent,Markdown,Obsidian,文献,本地优先,Zotero
```

**What's new in this version (0.3.2):**

```
• 首次 TestFlight 发布。
• 支持 iPhone 与 iPad，iOS 15.0+。
• 通过端到端加密中继配对桌面 Agentero。
• 阅读桌面文献库、PDF 与笔记；笔记可写回桌面。
• 与桌面 ACP Agent 流式对话。
```

**App Review notes:** keep the English block above. The Chinese
description and metadata are only for the App Store listing — the
review team reads the English notes by default, so leave the review
note unchanged across localizations.

### TestFlight (beta app information)

**Beta app description:**

```
Internal pre-release of Agentero iOS. Pairs with the developer's
desktop Agentero build over the relay at relay.philfan.cn. Used for
smoke testing the iOS remote-client shell (Connect → Library → PDF /
Notes → Agent chat) before the public App Store submission.
```

**What to test:** leave empty for initial 0.3.2.

### Submission checklist

- [ ] Privacy policy page exists at the URL above and returns 200.
- [ ] App Icon 1024×1024 PNG (no alpha, no rounded corners) uploaded.
- [ ] At least three 6.5" iPhone screenshots and one iPad screenshot
      uploaded to the English localization.
- [ ] Optional: a separate set of screenshots for the zh-CN
      localization (recommended for ASO).
- [ ] App Privacy questionnaire completed (all 14 categories →
      "Data Not Collected").
- [ ] Export compliance answered as exempt under Category 5 Part 2.
- [ ] **Sign-in required = No**; demo username/password left empty
      (no fake login or “test website login” for review).
- [ ] App Review notes field filled with the English pairing block above.
- [ ] Review contact email/phone filled; relay reachable for the review window
      (optional: demo desktop or revocable pairing link if reviewers need help).
- [ ] `ios-testflight.yml` GitHub Actions run produced the uploaded
      build (or the local `bash scripts/ios-testflight.sh` produced it
      with a matching build number).
