# ProxySwitch 隐私政策

**最后更新日期：** 2026 年 10 月 14 日

**生效日期：** 2026 年 9 月 28 日

### 1. 简介
ProxySwitch（以下简称“本扩展”）是一款旨在帮助用户管理代理设置和切换规则的 Chrome 浏览器扩展程序。我们重视您的隐私，并致力于保护您的个人数据。**我们不会通过开发者运营的服务器收集、存储或分享您的浏览记录或个人信息。**

### 2. 数据收集与使用
本扩展在您的设备上处理配置和诊断数据；启用云备份时，会直接与您选择的备份服务通信。我们通过以下方式处理数据：

*   **代理配置：** 代理服务器信息（名称、地址、端口和协议等）及规则保存在您的浏览器本地 (`chrome.storage.local`)，用于配置浏览器的网络连接。如果您使用云备份，服务器列表和规则也会上传至您选择的 GitHub Gist 或 WebDAV 服务，详情见“云端同步”。
*   **故障黑匣子：** 扩展会在本地保存有限数量的运行状态和启动诊断记录。诊断报告不会包含规则或 PAC 正文，并会隐藏密码、Token 和完整网页 URL；这些记录不会被自动上传。
*   **新增规则的本地撤销记录：** 仅在您明确选择域名并点击添加正式规则后，扩展在 `chrome.storage.local` 最多保留 10 分钟的操作记录，包括本次选中及真正新增的域名、方向、操作/会话标识、有效期、应用状态和规则列表的校验摘要，用于防止重复添加、安全撤销及失败重试；不另存完整规则列表。下一次添加替换该记录，清空关联页面记录或浏览器启动时清理；旧手动流程开启新一轮采集也会清理。页面变化后撤销入口可能不再显示。关闭自动记录不会删除有效撤销记录、试用或正式规则；记录过期或清理也不会删除正式规则。该操作记录不参加配置导出或云备份，也不发送给开发者。
*   **页面请求自动记录（可选）：** 默认关闭。只有您阅读功能内的观察范围及本机保留说明，明确点击“开启自动记录”并允许可选请求观察权限后，才会自动观察普通 HTTP/HTTPS 标签页当前页面的新请求。之前授予该权限不等于同意自动记录，升级不会静默开启。开启与查看记录不强制刷新页面，也不自动添加规则或切换代理模式。无痕及浏览器内部页面不支持。
    * 观察范围包含浏览器请求观察接口提供的 HTTP/HTTPS 请求事件及 WebSocket（WS/WSS）连接握手，不读取 WebSocket 消息或观察连接关闭。开启前的历史请求及已经建立的连接无法补查。扩展按域名汇总资源类型、请求/握手计数、HTTP 状态、错误及必要时间、标签页、会话/请求和文档标识，用于当前页关联及避免旧请求混入新页面；不保存完整 URL、Cookie、请求头、请求正文或消息内容。
    * 请求摘要缓存上限为 20 个标签页上下文、每页 200 个域名、合计 2,000 个域名、1,000 个进行中请求及 680 KiB。记录按各标签页当前页面隔离，导航变化或标签页关闭会清除对应旧记录，不形成长期浏览时间线。每页最后一次观察活动后最多保留 30 分钟；请求取消、后台重启或长时间没有终结事件时，未得到确认的结果不当作失败。
    * 自动记录摘要及其域名选择状态仅使用 `chrome.storage.session` 会话内存存储，浏览器重启、扩展重新加载或更新会清空缓存。较旧浏览器没有会话存储，或会话存储不可用时，仅使用有上限的后台内存，后台重启可能丢失记录；不会将自动记录缓存转存到 `chrome.storage.local`。自动记录开关本身是保存在 `chrome.storage.local` 的布尔偏好，您已明确开启的偏好可在后续启动继续生效。
    * 您可清空当前页面记录，或关闭自动记录/撤销观察权限以停止观察并清除自动缓存。清空后新请求仍可继续记录；若关闭偏好保存失败，界面会提示错误，请重试或在浏览器中撤销权限，不将未确认结果声明为永久关闭。自动偏好、请求摘要、选择状态和临时试用不参加配置导出或云备份，请求摘要也不写入故障黑匣子或发送给开发者。您主动添加或保存的正式规则遵循下述配置同步行为。
*   **兼容单次手动采集：** 旧手动流程仍可在您主动授权并开始采集后，只观察选中的普通标签页最多 60 秒；域名及请求摘要存于 `chrome.storage.local`，从本轮开始最多保留 30 分钟，可手动清空，不参加配置导出或云备份。其数据范围与上述请求摘要相同，不读取消息内容。正常使用新版自动记录无需反复开启单次采集。诊断中的临时试用规则最长有效 10 分钟。
*   **浏览活动 (标签页与 URL)：** 我们申请 `tabs` 权限以获取标签页当前页面的 URL。这**仅用于本地**执行以下操作：
    1.  检查当前 URL 是否匹配您配置的规则（如 GFWList）。
    2.  根据规则匹配结果更新扩展图标，显示当前页面的规则线路。
    3.  在您明确开启自动记录后，把各标签页的新请求关联到其当前页面，处理导航或关闭后的清理；将详细诊断绑定到原标签页，并在您操作时刷新或返回该页面。
    *   **自动记录默认关闭；开启后处理的域名及请求状态属于浏览活动数据，仅为可见的分流诊断功能在本机短期使用，不保存长期浏览历史。**
    *   **我们不会将您的浏览历史上传至任何服务器。**
*   **外部请求与连接观察（主机权限）：** 我们申请访问 HTTP/HTTPS URL，以及观察 WS/WSS 连接握手的主机权限。这在以下情况使用：
    1.  **您**主动点击更新，从您指定的远程 URL 下载 GFWList 规则列表。
    2.  **您**开启云同步功能，向您自己的 WebDAV 服务器或 GitHub Gist 上传/下载配置。
    3.  **您**主动测试代理延迟时，连接测试目标。
    4.  **您**明确启用自动记录或主动开始兼容手动采集时，配合可选的 `webRequest` 权限只读观察普通标签页请求及连接握手；此观察本身不向外发送记录。
*   **定时任务 (`alarms`)：** 用于清理到期的页面摘要和未确认请求状态，结束到期手动采集，清理诊断试用及恢复预览，以及检查您已开启的自动备份是否有待上传配置。定时任务不会自行开启请求观察，也不用于持续保持后台活动。

从 Chrome API 获得的信息仅用于上述已披露的代理配置、页面诊断及用户选择的配置备份功能，不出售浏览活动数据，不将其用于广告、用户画像或其他无关用途。ProxySwitch 对从 Chrome API 获得的信息的使用遵守 [Chrome Web Store 用户数据政策](https://developer.chrome.com/docs/webstore/program-policies/limited-use)，包括 Limited Use（有限用途）要求。仅在本机处理的数据同样适用本政策，并非因“不上传”而视为“未访问用户数据”。

### 3. 云端同步
如果您选择使用“云同步”功能（GitHub Gist 或 WebDAV）：
*   您可以手动上传或下载配置。自动同步默认关闭；开启自动同步并配置备份服务后，自定义代理规则、白名单、服务器列表、当前服务器选择或订阅地址的变化可能触发自动上传。待上传标记保存在本地，后台重新启动后可继续检查；关闭自动同步后不再执行排队的自动上传。
*   恢复前先在本地保存有效期为 5 分钟的预览；到期后清理。确认恢复时，在本地保留一份恢复前的配置快照，用于撤销上次云恢复。该快照在下一次恢复时替换，成功撤销或重置扩展时删除。预览、撤销快照和待上传标记不参加云备份；普通浏览器会话临时规则也不参加云备份。
*   您的认证令牌（如 GitHub Token、WebDAV 密码）仅存储在您的本地设备上。
*   这些凭据会**直接**发送给服务提供商（GitHub 或您的 WebDAV 服务器）以进行身份验证。
*   服务器列表、规则等配置以**可读 JSON** 上传；同步凭据不会写入备份，但本扩展不会对备份文件进行额外加密或 Base64 编码。
*   您的 Token、密码或同步数据不会经过或存储在 ProxySwitch 开发者运营的服务器上。

### 4. 权限使用说明

*   **`proxy`（代理）：** 用于根据您的操作修改浏览器的代理设置（系统、直连、PAC 或固定服务器）。
*   **`storage`（存储）：** 用于在您的设备本地保存设置、规则、界面偏好和诊断摘要。
*   **`tabs`（标签页）：** 用于获取当前页面域名、显示依据规则计算的线路状态，关联普通标签页当前页面的请求摘要及导航/关闭后的清理，将详细诊断绑定到原标签页，在您操作时刷新或返回该页面。
*   **`webRequest`（可选，请求观察）：** 仅在您授权且明确开启自动记录后，只读观察普通标签页当前页面的 HTTP/HTTPS 请求及 WebSocket 握手的生命周期、类型、状态码与错误；也支持用户发起的兼容手动采集。用于让您发现第三方连接问题并自行添加代理或直连规则，不读取实时消息、不拦截或修改请求，不使用 `webRequestBlocking` 权限。
*   **`alarms`（定时任务）：** 用于清理到期请求摘要及未确认状态、结束到期手动采集、清理临时试用及恢复预览，并检查用户已开启的自动备份待上传状态；不自行开启观察，不持续唤醒后台。
*   **主机权限（`http://*/*`、`https://*/*`、`ws://*/*`、`wss://*/*`）：** HTTP/HTTPS 用于下载您指定的规则列表、连接代理延迟测试目标、与您配置的备份服务通信；这四种协议的授权还配合可选 `webRequest` 权限，在您开启诊断后观察请求及 WebSocket 握手。扩展不申请文件或其他协议的主机访问权限。

### 5. 第三方服务
根据您的配置，本扩展可能会与以下第三方服务交互：
*   **GitHub：** 如果您使用 Gist 同步或从 GitHub 获取规则。
*   **用户自定义的 WebDAV 服务器：** 如果您配置了 WebDAV 同步。
*   **规则列表提供方：** 您输入的用于下载代理规则的任何 URL（如 jsDelivr）。
请参阅这些相应服务的隐私政策。

### 6. 数据安全
您的设置、兼容手动摘要及主动添加规则的撤销记录存储在浏览器本地存储沙盒中；自动请求摘要与其选择状态仅保留在会话内存存储或有限后台内存中，不持久写入本地配置。云备份是可读 JSON，没有额外加密。GitHub 的非公开（secret）Gist 并非访问受限的私有仓库，链接持有者仍可读取内容；本扩展拒绝使用同名公开 Gist。请使用可信备份服务并保护链接。远程 WebDAV 必须使用 HTTPS，本机回环服务器可使用 HTTP。

### 7. 政策变更

我们会不时更新本隐私政策。如果我们进行重大更改，将通过扩展程序的更新说明或 Chrome 网上应用店列表通知用户。

### 8. 联系我们
如果您对本隐私政策有任何疑问，请通过以下方式联系我们：
**xcyebgkob@mozmail.com**

---

# Privacy Policy for ProxySwitch / ProxySwitch 隐私政策

**Last Updated:** October 14, 2026
**Effective Date:** September 28, 2026


### 1. Introduction
ProxySwitch ("we", "our", or "the extension") is a Chrome browser extension designed to help users manage proxy settings and switch rules. We value your privacy and are committed to protecting your personal data. **We do not collect, store, or share your browsing history or personal information on our servers.**

### 2. Data Collection and Usage
The extension processes configuration and diagnostic data on your device. When cloud backup is enabled, it communicates directly with the backup service you choose. We handle data in the following ways:

*   **Proxy Configuration:** Proxy server information, such as names, addresses, ports, and protocols, and routing rules are stored locally in your browser (`chrome.storage.local`) to configure its network connections. If you use cloud backup, server lists and rules are also uploaded to your chosen GitHub Gist or WebDAV service, as explained under Cloud Synchronization.
*   **Fault Black Box:** The extension locally retains a limited number of runtime-state and startup-diagnostic records. Reports exclude rule and PAC contents and redact passwords, tokens, and full page URLs. These records are never uploaded automatically.
*   **Local Rule-Addition Undo Records:** Only after you explicitly select domains and add permanent rules, the extension keeps an operation record in `chrome.storage.local` for up to 10 minutes: selected and actually added domains, direction, operation/session identifiers, expiry, application state, and a rule-list fingerprint. It prevents duplicate additions and supports safe undo and application retry without storing another full rule list. The next addition replaces it; clearing associated page records or browser startup removes it. Starting a new legacy manual capture also removes it. Navigation may hide its undo control. Disabling automatic recording does not delete valid undo records, trials, or permanent rules; expiry or cleanup of records does not delete permanent rules either. These operation records are excluded from configuration export and cloud backup and are not sent to the developer.
*   **Automatic Page Request Recording (Optional):** Off by default. Automatic observation of new requests from normal HTTP/HTTPS tabs' current pages starts only after you review the in-feature scope and local-retention notice, explicitly choose **Enable automatic recording**, and allow the optional request-observation permission. An earlier permission grant is not consent to automatic recording; upgrading does not silently enable it. Enabling and viewing do not force a page reload, automatically add rules, or switch proxy modes. Incognito and internal browser pages are excluded.
    * Observation covers HTTP/HTTPS request events and WebSocket (WS/WSS) handshakes provided by the browser's request-observation API, not WebSocket messages or connection closure. Earlier requests and established connections cannot be recovered. Domain summaries contain resource types, request/handshake counts, HTTP statuses, errors, and necessary timestamps, tab/session/request and document identifiers to associate the current page and fence older requests. Full URLs, cookies, request headers, bodies, and message contents are not saved.
    * The request-summary cache is bounded to 20 tab contexts, 200 domains per page, 2,000 domains overall, 1,000 in-flight requests, and 680 KiB. Each tab's current-page records are separate; navigation changes and tab closure remove the corresponding older records rather than retaining a long-term browsing timeline. Each page is retained for up to 30 minutes after its last observed activity. Unconfirmed outcomes after cancellation, background restart, or a long wait without a terminal event are not counted as failures.
    * Automatic summaries and their domain-selection state use only `chrome.storage.session` browser-session memory storage, cleared by browser restart, extension reload, or update. Older browsers without session storage, or unavailable session storage, use bounded background memory only and may lose records on background restart. Automatic caches are never moved into `chrome.storage.local`. The automatic-recording preference itself is a boolean saved in `chrome.storage.local`; an explicitly enabled preference can remain active on later starts.
    * Clear the current page's summaries, or disable automatic recording/revoke observation permission to stop observation and clear automatic caches. New requests continue to be recorded after clearing. If saving the disabled preference fails, the UI reports an error; retry or revoke permission in the browser rather than treating an unconfirmed result as permanently disabled. Automatic preferences, request summaries, selection state, and temporary trials are excluded from configuration export and cloud backup. Request summaries do not enter the fault black box or go to the developer. Permanent rules you explicitly add or save follow the configuration-sync behavior below.
*   **Legacy Single-Tab Manual Capture:** For compatibility, the previous flow remains supported: after you grant permission and initiate a capture, only the selected normal tab is observed for up to 60 seconds. Its domain/request summaries are saved in `chrome.storage.local` for up to 30 minutes from capture start, can be cleared manually, and are excluded from configuration export and cloud backup. They use the same limited summary fields described above and do not read message contents. Normal use of the new automatic recorder does not require repeated manual captures. Diagnostic trial rules last at most 10 minutes.
*   **Browsing Activity (Tabs & URLs):** We request the `tabs` permission to access tabs' current-page URLs. This is used **strictly locally** to:
    1.  Check if the current URL matches your configured rules (e.g., GFWList).
    2.  Update the extension icon based on rule matches to show the current page's predicted route.
    3.  After explicit consent to automatic recording, associate new requests with each tab's current page and handle navigation/closure cleanup; bind detailed diagnostics to the source tab and reload or return to that page when requested.
    *   **Automatic recording is off by default. Domain and request-status summaries processed after consent are browsing-activity data, used briefly on-device for the visible routing-diagnostics feature rather than a long-term browsing history.**
    *   **We do NOT upload your browsing history to any server.**
*   **External Requests and Connection Observation (Host Permissions):** We request access to HTTP/HTTPS URLs and host permissions for observing WS/WSS connection handshakes. These are used when:
    1.  **You** initiate a request to update the GFWList (Rule List) from a remote URL you specified.
    2.  **You** enable Cloud Sync to upload/download configurations to/from your own WebDAV server or GitHub Gist.
    3.  **You** start a proxy latency test, which connects to the test target.
    4.  **You** explicitly enable automatic recording or initiate a legacy manual capture, when host access and the optional `webRequest` permission support read-only observation of normal tabs' requests and connection handshakes. Observation itself does not transmit records.
*   **Scheduled Tasks (`alarms`):** Clean up expired page summaries and unconfirmed request states, end expired manual captures, expire diagnostic trials and restore previews, and check pending configuration uploads when you have enabled automatic backup. Alarms do not independently enable request observation or keep the background continuously active.

Information received from Chrome APIs is used only for the disclosed proxy configuration, page diagnostics, and user-chosen configuration backup features. Browsing-activity data is not sold or used for advertising, profiling, or unrelated purposes. The use of information received from Chrome APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including its Limited Use requirements. Data processed only on-device is also covered by this policy; not uploading data does not mean no user data is accessed.

### 3. Cloud Synchronization
If you choose to use the "Cloud Sync" feature (GitHub Gist or WebDAV):
*   You can upload or download configuration manually. Automatic sync is off by default. Once enabled and configured, changes to custom proxy rules, the direct list, server lists, the active server selection or the subscription URL may trigger an automatic upload. Pending-upload markers are saved locally and checked again after worker restarts. Turning automatic sync off prevents queued automatic uploads from running.
*   Before restoring, a local preview is kept for up to five minutes and cleaned up on expiry. A confirmed restore retains one local snapshot of the previous configuration to undo the last cloud restore. The next restore replaces it; successful undo or resetting the extension removes it. Previews, undo snapshots, pending-upload markers and ordinary browser-session temporary rules are excluded from cloud backups.
*   Your authentication tokens (e.g., GitHub Token, WebDAV password) are stored locally on your device.
*   These credentials are sent **directly** to the service provider (GitHub or your WebDAV server) to authenticate requests.
*   Configuration such as server lists and rules is uploaded as **readable JSON**. Sync credentials are excluded from the backup, but the extension does not additionally encrypt or Base64-encode the backup file.
*   Your tokens, passwords, and synchronized data do not pass through or reside on servers operated by the ProxySwitch developers.

### 4. Permissions Usage

*   **`proxy`:** Modifies the browser's proxy settings (System, Direct, PAC, or fixed servers) as requested by you.
*   **`storage`:** Saves settings, rules, UI preferences, and diagnostic summaries locally on your device.
*   **`tabs`:** Reads current hostnames to show predicted rule routes, associates summaries with normal tabs' current pages and cleans up on navigation/closure, binds detailed diagnostics to the source tab, and reloads or returns to that page when requested.
*   **`webRequest` (Optional):** After you grant permission and explicitly enable automatic recording, read-only observation covers the lifecycle, types, status codes, and errors of normal tabs' current-page HTTP/HTTPS requests and WebSocket handshakes. User-initiated legacy manual captures are also supported. This helps you identify third-party connection issues and choose proxy/direct rules. It does not read real-time messages, intercept or modify requests, or use the `webRequestBlocking` permission.
*   **`alarms`:** Cleans up expired request summaries and unconfirmed states, ends expired manual captures, expires trials and restore previews, and checks pending uploads for user-enabled automatic backup. It does not independently enable observation or continuously wake the background.
*   **Host permissions (`http://*/*`, `https://*/*`, `ws://*/*`, `wss://*/*`):** HTTP/HTTPS access downloads your chosen rule lists, connects to proxy latency-test targets, and communicates with your configured backup service. Access to these four schemes also works with the optional `webRequest` permission to observe requests and WebSocket handshakes after you enable diagnostics. The extension does not request file or other-scheme host access.

### 5. Third-Party Services
The extension may interact with the following third-party services based on your configuration:
*   **GitHub:** If you use GitHub Gist for sync or fetch rules from GitHub.
*   **User-defined WebDAV Servers:** If you configure WebDAV sync.
*   **Rule List Providers:** Any URL you input to download proxy rules (e.g., jsDelivr).
Please refer to the privacy policies of these respective services.

### 6. Data Security
Your settings, legacy manual summaries, and explicit rule-addition undo records are stored in the browser's local storage sandbox. Automatic request summaries and selection state remain only in session memory storage or bounded background memory; they are not persisted in local configuration. Cloud backups are readable JSON without additional encryption. GitHub secret Gists are not access-restricted private repositories: anyone with their link can read them. The extension refuses matching public Gists. Use a trusted provider and protect backup links. Remote WebDAV requires HTTPS; loopback servers may use HTTP.

### 7. Changes to This Policy

We may update this Privacy Policy from time to time. If we make significant changes, we will notify users through the extension's update notes or the Chrome Web Store listing.

### 8. Contact Us
If you have any questions about this Privacy Policy, please contact us at:
**xcyebgkob@mozmail.com**
