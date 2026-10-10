# ProxySwitch 隐私政策

**最后更新日期：** 2026 年 10 月 10 日

**生效日期：** 2026 年 9 月 28 日

### 1. 简介
ProxySwitch（以下简称“本扩展”）是一款旨在帮助用户管理代理设置和切换规则的 Chrome 浏览器扩展程序。我们重视您的隐私，并致力于保护您的个人数据。**我们不会通过开发者运营的服务器收集、存储或分享您的浏览记录或个人信息。**

### 2. 数据收集与使用
本扩展在您的设备上处理配置和诊断数据；启用云备份时，会直接与您选择的备份服务通信。我们通过以下方式处理数据：

*   **代理配置：** 代理服务器信息（名称、地址、端口和协议等）及规则保存在您的浏览器本地 (`chrome.storage.local`)，用于配置浏览器的网络连接。如果您使用云备份，服务器列表和规则也会上传至您选择的 GitHub Gist 或 WebDAV 服务，详情见“云端同步”。
*   **故障黑匣子：** 扩展会在本地保存有限数量的运行状态和启动诊断记录。诊断报告不会包含规则或 PAC 正文，并会隐藏密码、Token 和完整网页 URL；这些记录不会被自动上传。
*   **页面请求诊断（可选）：** 仅在您主动授权请求观察权限并开始采集后，观察您选择的普通 HTTP/HTTPS 标签页，每次最长 60 秒，不支持无痕标签页。扩展在本地按域名汇总资源类型、请求计数、HTTP 状态、错误及必要的会话时间/标签页标识；最多保留 200 个域名，并限制进行中请求数量。不保存完整 URL、Cookie、请求头或请求正文。采集记录存入 `chrome.storage.local`，30 分钟后清理，您也可手动清空。临时试用规则最长有效 10 分钟。采集记录及临时试用不参加配置导出或云备份，也不会发送给开发者；您主动保存的正式规则遵循下述配置同步行为。
*   **浏览活动 (标签页与 URL)：** 我们申请 `tabs` 权限以获取当前活动标签页的 URL。这**仅用于本地**执行以下操作：
    1.  检查当前 URL 是否匹配您配置的规则（如 GFWList）。
    2.  根据规则匹配结果更新扩展图标，显示当前页面的规则线路。
    3.  将您主动开启的页面诊断绑定到原标签页，并在您操作时刷新或返回该页面。
    *   **不会默认记录浏览历史；主动开启诊断时仅本地暂存上述有限的请求摘要。**
    *   **我们不会将您的浏览历史上传至任何服务器。**
*   **外部请求 (主机权限)：** 我们申请访问 HTTP/HTTPS URL 的权限。这在以下情况使用：
    1.  **您**主动点击更新，从您指定的远程 URL 下载 GFWList 规则列表。
    2.  **您**开启云同步功能，向您自己的 WebDAV 服务器或 GitHub Gist 上传/下载配置。
    3.  **您**主动测试代理延迟时，连接测试目标。
    4.  **您**启用页面诊断时，配合可选的 `webRequest` 权限观察目标标签页请求；此观察本身不向外发送采集记录。
*   **定时清理 (`alarms`)：** 用于在页面请求采集到期时结束观察，并清理过期的诊断记录及临时试用状态，不用于自动开始采集或定期追踪浏览活动。

### 3. 云端同步
如果您选择使用“云同步”功能（GitHub Gist 或 WebDAV）：
*   您可以手动上传或下载配置。自动同步默认关闭；开启自动同步并配置备份服务后，自定义代理规则、白名单或服务器列表的变化也可能触发自动上传，无需每次手动点击上传。
*   您的认证令牌（如 GitHub Token、WebDAV 密码）仅存储在您的本地设备上。
*   这些凭据会**直接**发送给服务提供商（GitHub 或您的 WebDAV 服务器）以进行身份验证。
*   服务器列表、规则等配置以**可读 JSON** 上传；同步凭据不会写入备份，但本扩展不会对备份文件进行额外加密或 Base64 编码。
*   您的 Token、密码或同步数据不会经过或存储在 ProxySwitch 开发者运营的服务器上。

### 4. 第三方服务
根据您的配置，本扩展可能会与以下第三方服务交互：
*   **GitHub：** 如果您使用 Gist 同步或从 GitHub 获取规则。
*   **用户自定义的 WebDAV 服务器：** 如果您配置了 WebDAV 同步。
*   **规则列表提供方：** 您输入的用于下载代理规则的任何 URL（如 jsDelivr）。
请参阅这些相应服务的隐私政策。

### 5. 数据安全
您的设置和诊断记录存储在浏览器的本地存储沙盒中。云备份是可读 JSON，安全性取决于您选择的服务、访问权限和传输方式；请使用私有 Gist 或受保护的 WebDAV，并优先使用 HTTPS。

### 6. 联系我们
如果您对本隐私政策有任何疑问，请通过以下方式联系我们：
**xcyebgkob@mozmail.com**

---

# Privacy Policy for ProxySwitch / ProxySwitch 隐私政策

**Last Updated:** October 10, 2026
**Effective Date:** September 28, 2026


### 1. Introduction
ProxySwitch ("we", "our", or "the extension") is a Chrome browser extension designed to help users manage proxy settings and switch rules. We value your privacy and are committed to protecting your personal data. **We do not collect, store, or share your browsing history or personal information on our servers.**

### 2. Data Collection and Usage
The extension processes configuration and diagnostic data on your device. When cloud backup is enabled, it communicates directly with the backup service you choose. We handle data in the following ways:

*   **Proxy Configuration:** Proxy server information, such as names, addresses, ports, and protocols, and routing rules are stored locally in your browser (`chrome.storage.local`) to configure its network connections. If you use cloud backup, server lists and rules are also uploaded to your chosen GitHub Gist or WebDAV service, as explained under Cloud Synchronization.
*   **Fault Black Box:** The extension locally retains a limited number of runtime-state and startup-diagnostic records. Reports exclude rule and PAC contents and redact passwords, tokens, and full page URLs. These records are never uploaded automatically.
*   **Page Request Diagnostics (Optional):** Only after you grant the optional request-observation permission and start a capture, the extension observes your selected normal HTTP/HTTPS tab for up to 60 seconds. Incognito tabs are not supported. Local domain summaries contain resource types, request counts, HTTP statuses, errors, and necessary session timestamps/tab identifiers. At most 200 domains are retained, and in-flight requests are bounded. Full URLs, cookies, request headers, and request bodies are not saved. Capture records are stored in `chrome.storage.local`, cleaned up after 30 minutes, and can be cleared manually. Temporary trial rules last at most 10 minutes. Captures and trials are excluded from configuration export and cloud backup and are not sent to the developer; permanent rules you explicitly save follow the configuration-sync behavior below.
*   **Browsing Activity (Tabs & URLs):** We request the `tabs` permission to access the URL of the active tab. This is used **strictly locally** to:
    1.  Check if the current URL matches your configured rules (e.g., GFWList).
    2.  Update the extension icon based on rule matches to show the current page's predicted route.
    3.  Bind a user-initiated diagnostic capture to its source tab and reload or return to that page when you request it.
    *   **We do not record browsing history by default. User-initiated diagnostics temporarily retain only the limited local request summaries described above.**
    *   **We do NOT upload your browsing history to any server.**
*   **External Requests (Host Permissions):** We request access to HTTP/HTTPS URLs. This is used when:
    1.  **You** initiate a request to update the GFWList (Rule List) from a remote URL you specified.
    2.  **You** enable Cloud Sync to upload/download configurations to/from your own WebDAV server or GitHub Gist.
    3.  **You** start a proxy latency test, which connects to the test target.
    4.  **You** enable page diagnostics, when host access and the optional `webRequest` permission allow observing the selected tab's requests. Observation itself does not transmit captured records.
*   **Scheduled Cleanup (`alarms`):** Used to end request observation when a capture expires and clean up expired diagnostic records and trial state. It does not start captures automatically or periodically track browsing activity.

### 3. Cloud Synchronization
If you choose to use the "Cloud Sync" feature (GitHub Gist or WebDAV):
*   You can upload or download configuration manually. Automatic sync is off by default. After you enable it and configure a backup service, changes to custom proxy rules, the direct list, or server lists may also trigger an automatic upload without clicking Upload each time.
*   Your authentication tokens (e.g., GitHub Token, WebDAV password) are stored locally on your device.
*   These credentials are sent **directly** to the service provider (GitHub or your WebDAV server) to authenticate requests.
*   Configuration such as server lists and rules is uploaded as **readable JSON**. Sync credentials are excluded from the backup, but the extension does not additionally encrypt or Base64-encode the backup file.
*   Your tokens, passwords, and synchronized data do not pass through or reside on servers operated by the ProxySwitch developers.

### 4. Third-Party Services
The extension may interact with the following third-party services based on your configuration:
*   **GitHub:** If you use GitHub Gist for sync or fetch rules from GitHub.
*   **User-defined WebDAV Servers:** If you configure WebDAV sync.
*   **Rule List Providers:** Any URL you input to download proxy rules (e.g., jsDelivr).
Please refer to the privacy policies of these respective services.

### 5. Data Security
Your settings and diagnostic records are stored in the browser's local storage sandbox. Cloud backups are readable JSON, so their security depends on your chosen provider, access controls, and transport. Use a private Gist or protected WebDAV service and prefer HTTPS.

### 6. Contact Us
If you have any questions about this Privacy Policy, please contact us at:
**xcyebgkob@mozmail.com**
