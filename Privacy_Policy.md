# Privacy Policy (隐私权政策)

**Last Updated:** October 10, 2026

## <span id="cn">中文版 (Chinese Version)</span>

### 1. 简介
**ProxySwitch**（以下简称“我们”）非常重视您的隐私。本隐私权政策旨在说明当您使用我们的 Chrome 扩展程序时，我们如何处理您的数据。

**ProxySwitch 的核心原则是隐私至上：我们不会通过开发者服务器收集、存储或传输您的个人数据、浏览历史或网络流量数据。** 数据处理发生在您的设备本地，或直接发生在您的设备与您配置的第三方服务（如 GitHub、WebDAV）之间。您主动开启的页面请求诊断会在本地短期保存有限摘要，详情如下。

### 2. 数据收集与使用

扩展为代理管理和诊断功能处理本地配置、页面域名及有限的诊断摘要。下文说明这些数据的用途，以及您选择启用云备份时传输到所选服务的数据；这些处理不经过开发者运营的服务器。

*   **浏览历史与 URL：**
    *   扩展程序在**本地**访问当前标签页的 URL，用于判断适用哪条代理规则（如自动、全局或直连）、更新图标状态，以及将用户主动开启的诊断绑定至原标签页。
    *   默认不记录浏览历史；完整浏览 URL 不会作为诊断记录保存或上传，也不会发送给我们或任何第三方用于追踪目的。
*   **代理配置与规则：**
    *   您的服务器列表、自定义规则（黑/白名单）及设置均存储在您浏览器的**本地存储** (`chrome.storage.local`) 中。
    *   使用云备份时，服务器列表和规则也会上传至您选择的服务，详见下一节。
*   **故障诊断记录：**
    *   “故障黑匣子”仅在本地保存有限数量的运行状态和启动记录。报告不包含规则或 PAC 正文，并会隐藏密码、Token 和完整网页 URL；诊断记录不会被自动上传。
*   **页面请求诊断（用户主动开启）：**
    *   首次需授予可选的请求观察权限，之后仍需主动开始采集。默认不监控，单次仅观察您选中的普通 HTTP/HTTPS 标签页，最长 60 秒，不支持无痕标签页。
    *   本地摘要包含域名、资源类型、计数、HTTP 状态、错误及必要的会话时间/标签页标识。最多保留 200 个域名，并限制进行中请求数量；不保存完整 URL、Cookie、请求头或请求正文。
    *   采集记录存入 `chrome.storage.local`，30 分钟后清理，也可手动清空。临时试用规则最长有效 10 分钟。
    *   采集记录与临时试用不参加配置导出或云备份，不上传至开发者或第三方。您主动保存的正式规则属于配置，可按您选择的云备份方式同步。
*   **认证令牌（云端备份）：**
    *   如果您使用“云端备份”功能，您的 GitHub Token 或 WebDAV 账号密码仅保存在您的浏览器本地。它们**仅**用于与您选择的服务提供商进行身份验证。我们无法获取这些凭据。

### 3. 云端备份与恢复（可选）

本扩展程序包含“云端备份”功能，允许您跨设备同步配置。这是一个**可选**功能。

您可以手动上传或下载配置。自动同步默认关闭；开启自动同步并配置备份服务后，自定义代理规则、白名单或服务器列表的变化也可能触发自动上传，无需每次手动点击上传。

*   **GitHub Gist / WebDAV：** 如果您选择使用此功能，服务器列表、规则等配置将以**可读 JSON**直接从您的浏览器传输到**您自己的** GitHub Gist 或 WebDAV 服务器。同步凭据不会写入备份，但本扩展不会对备份文件进行额外加密或 Base64 编码。
*   **无中间商：** 此传输过程是点对点的，不经过 ProxySwitch 开发者的任何服务器。

### 4. 权限使用说明

我们仅申请扩展程序正常运行所需的最小权限：

*   **`proxy` (代理)**：用于根据用户的操作修改浏览器的代理设置（系统、直连、PAC 或固定服务器）。
*   **`storage` (存储)**：用于在您的设备本地保存设置、规则、界面偏好和诊断摘要。
*   **`tabs` (标签页)**：用于获取当前页面域名、显示依据规则计算的线路状态，并将诊断绑定到原标签页，在您操作时刷新或返回该页面。
*   **`webRequest`（可选，请求观察）**：仅在您授权并主动开启页面诊断后，用于观察选定标签页的请求生命周期、类型、状态码与错误，不拦截或修改请求。
*   **`alarms`（定时任务）**：用于在采集到期时结束请求观察，并清理到期的诊断记录及临时试用状态，不用于自动开始采集。
*   **`host_permissions` (`http://*/*`、`https://*/*`)**：
    *   用于从公共仓库（如 GitHub 或 jsDelivr）下载 GFWList 规则列表。
    *   用于对代理服务器进行延迟测试（连接目标 URL）。
    *   用于与 GitHub API 或您的 WebDAV 服务器通信，以执行备份/恢复功能。
    *   与可选 `webRequest` 权限配合，仅在您开启诊断时观察目标标签页的请求。

### 5. 第三方服务

*   **GFWList：** 扩展程序可能会从 GitHub 或 CDN 下载公共规则列表。这是一个只读操作。
*   **云服务提供商：** 如果您使用备份功能，即表示您同意并受相应服务提供商（如 GitHub 隐私声明）的约束。

### 6. 数据安全

我们不通过自己的服务器收集或中转您的配置。云备份是可读 JSON，其安全性取决于您选择的服务、访问权限和传输方式；请使用私有 Gist 或受保护的 WebDAV，并优先使用 HTTPS。

### 7. 政策变更

我们会不时更新本隐私权政策。如果我们进行重大更改，将通过扩展程序的更新说明或 Chrome 网上应用店列表通知用户。

### 8. 联系我们

如果您对本隐私权政策有任何疑问，请通过以下方式联系我们：
**电子邮箱：** [xcyebgkob@mozmail.com]

---


## <span id="en">English Version</span>

### 1. Introduction
**ProxySwitch** ("we", "us", or "our") is committed to protecting your privacy. This Privacy Policy explains how we handle your data when you use our Chrome Extension.

**The core principle of ProxySwitch is privacy-first: We do not collect, store, or transmit your personal data, browsing history, or traffic data through developer-operated servers.** Processing happens locally on your device or directly between your device and the third-party services you explicitly configure (e.g., GitHub, WebDAV). Page request diagnostics you explicitly start retain limited local summaries temporarily, as described below.

### 2. Data Collection and Usage

The extension processes local configuration, page domains, and limited diagnostic summaries for proxy management and troubleshooting. The sections below explain their use and what is transmitted to your chosen service if you enable cloud backup. These operations do not pass through developer-operated servers.

*   **Browsing History & URLs:**
    *   The extension accesses the current tab's URL **locally** to determine which proxy rule applies (e.g., Auto, Global, or Direct), update the extension icon, and bind a user-initiated diagnostic capture to its source tab.
    *   Browsing history is not recorded by default. Full browsing URLs are not saved or uploaded as diagnostic records and are not sent to us or third parties for tracking.
*   **Proxy Configurations & Rules:**
    *   Your server lists, custom rules (user rules/whitelists), and settings are stored in your browser's **Local Storage** (`chrome.storage.local`).
    *   If you use cloud backup, server lists and rules are also uploaded to the service you choose, as explained in the next section.
*   **Fault Diagnostics:**
    *   The Fault Black Box locally retains a limited number of runtime-state and startup records. Reports exclude rule and PAC contents and redact passwords, tokens, and full page URLs. Diagnostic records are never uploaded automatically.
*   **Page Request Diagnostics (User-Initiated):**
    *   First use requires the optional request-observation permission, and each capture must still be started by you. Monitoring is off by default. A capture observes only your selected normal HTTP/HTTPS tab for up to 60 seconds; incognito tabs are not supported.
    *   Local summaries contain domains, resource types, counts, HTTP statuses, errors, and necessary session timestamps/tab identifiers. At most 200 domains are retained, and in-flight requests are bounded. Full URLs, cookies, request headers, and request bodies are not saved.
    *   Captures are stored in `chrome.storage.local`, cleaned up after 30 minutes, and can be cleared manually. Temporary trial rules last at most 10 minutes.
    *   Captures and temporary trials are excluded from configuration export and cloud backup and are not uploaded to the developer or third parties. Permanent rules you explicitly save become configuration and may be synchronized through your chosen cloud backup service.
*   **Authentication Tokens (Cloud Backup):**
    *   If you use the "Cloud Backup" feature, your GitHub Token or WebDAV credentials are saved locally in your browser. They are used **strictly** to authenticate with the service provider you chose. We do not have access to these credentials.

### 3. Cloud Backup & Restore (Optional)

The extension includes a "Cloud Backup" feature that allows you to sync your configurations across devices. This is an **optional** feature.

You can upload or download configuration manually. Automatic sync is off by default. After you enable it and configure a backup service, changes to custom proxy rules, the direct list, or server lists may also trigger an automatic upload without clicking Upload each time.

*   **GitHub Gist / WebDAV:** If you choose to use this feature, configuration such as server lists and rules is transmitted as **readable JSON** directly from your browser to **your own** GitHub Gist or WebDAV server. Sync credentials are excluded from the backup, but the extension does not additionally encrypt or Base64-encode the backup file.
*   **No Intermediary:** This transmission occurs directly. Does not pass through any servers owned by ProxySwitch developers.

### 4. Permissions Usage

We request the minimum permissions necessary for the extension to function:

*   **`proxy`**: Required to modify the browser's proxy settings (System, Direct, PAC, or Fixed servers) as requested by the user.
*   **`storage`**: Saves settings, rules, UI preferences, and diagnostic summaries locally on your device.
*   **`tabs`**: Reads the current page's hostname to show a predicted rule route, binds diagnostics to the source tab, and reloads or returns to that page when requested.
*   **`webRequest` (Optional)**: Observes the selected tab's request lifecycle, types, status codes, and errors only after you grant permission and start page diagnostics. It does not intercept or modify requests.
*   **`alarms`**: Ends request observation when a capture expires and cleans up expired diagnostic records and temporary trial state; does not start captures automatically.
*   **`host_permissions` (`http://*/*`, `https://*/*`)**:
    *   To download the GFWList rule set from public repositories (e.g., GitHub or jsDelivr).
    *   To perform latency tests on your proxy servers (connecting to target URLs).
    *   To communicate with the GitHub API or your WebDAV server for the Backup/Restore feature.
    *   Together with the optional `webRequest` permission, to observe the selected tab's requests when you start diagnostics.

### 5. Third-Party Services

*   **GFWList:** The extension may download public rule lists from GitHub or CDNs. This is a read-only operation.
*   **Cloud Providers:** If you use the backup feature, you are subject to the privacy policies of the respective providers (e.g., GitHub Privacy Statement).

### 6. Data Security

We do not collect or relay your configuration through our own servers. Cloud backups are readable JSON, so their security depends on your chosen provider, access controls, and transport. Use a private Gist or protected WebDAV service and prefer HTTPS.

### 7. Changes to This Policy

We may update this Privacy Policy from time to time. If we make significant changes, we will notify users through the extension's update notes or the Chrome Web Store listing.

### 8. Contact Us

If you have any questions about this Privacy Policy, please contact us at:
**Email:** [xcyebgkob@mozmail.com]
