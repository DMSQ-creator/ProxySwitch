# Privacy Policy (隐私权政策)

**Last Updated:** December 24, 2025

## <span id="cn">中文版 (Chinese Version)</span>

### 1. 简介
**ProxySwitch**（以下简称“我们”）非常重视您的隐私。本隐私权政策旨在说明当您使用我们的 Chrome 扩展程序时，我们如何处理您的数据。

**ProxySwitch 的核心原则是隐私至上：我们要明确声明，我们绝不会收集、存储或向我们的服务器传输您的个人数据、浏览历史或网络流量数据。** 所有的在数据处理均发生在您的设备本地，或直接发生在您的设备与您配置的第三方服务（如 GitHub、WebDAV）之间。

### 2. 数据收集与使用

我们不收集任何个人身份信息 (PII)。以下是关于数据处理的详细说明：

*   **浏览历史与 URL：**
    *   扩展程序仅在**本地**访问您当前活动标签页的 URL，用于判断适用哪条代理规则（如自动、全局或直连），并据此改变扩展程序的图标状态。
    *   **此类数据绝不会离开您的浏览器**，也不会发送给我们或任何第三方用于追踪目的。
*   **代理配置与规则：**
    *   您的服务器列表、自定义规则（黑/白名单）及设置均存储在您浏览器的**本地存储** (`chrome.storage.local`) 中。
*   **认证令牌（云端备份）：**
    *   如果您使用“云端备份”功能，您的 GitHub Token 或 WebDAV 账号密码仅保存在您的浏览器本地。它们**仅**用于与您选择的服务提供商进行身份验证。我们无法获取这些凭据。

### 3. 云端备份与恢复（用户主动发起）

本扩展程序包含“云端备份”功能，允许您跨设备同步配置。这是一个**可选**功能。

*   **GitHub Gist / WebDAV：** 如果您选择使用此功能，您的配置数据（经过编码处理）将直接从您的浏览器传输到**您自己的** GitHub Gist 或 WebDAV 服务器。
*   **无中间商：** 此传输过程是点对点的，不经过 ProxySwitch 开发者的任何服务器。

### 4. 权限使用说明

我们仅申请扩展程序正常运行所需的最小权限：

*   **`proxy` (代理)**：用于根据用户的操作修改浏览器的代理设置（系统、直连、PAC 或固定服务器）。
*   **`storage` (存储)**：用于在您的设备本地保存设置和规则。
*   **`tabs` (标签页)**：用于检测当前标签页的 URL，以便在弹窗界面中显示路由状态（例如“已代理”或“直连”）。
*   **`host_permissions` (主机权限)**：
    *   用于从公共仓库（如 GitHub 或 jsDelivr）下载 GFWList 规则列表。
    *   用于对代理服务器进行延迟测试（连接目标 URL）。
    *   用于与 GitHub API 或您的 WebDAV 服务器通信，以执行备份/恢复功能。

### 5. 第三方服务

*   **GFWList：** 扩展程序可能会从 GitHub 或 CDN 下载公共规则列表。这是一个只读操作。
*   **云服务提供商：** 如果您使用备份功能，即表示您同意并受相应服务提供商（如 GitHub 隐私声明）的约束。

### 6. 数据安全

由于我们不收集您的数据，因此不存在数据从我们服务器泄露的风险。对于存储在本地或云端账户中的数据，我们在适用的情况下使用标准编码（Base64）对配置文件进行混淆处理。

### 7. 政策变更

我们会不时更新本隐私权政策。如果我们进行重大更改，将通过扩展程序的更新说明或 Chrome 网上应用店列表通知用户。

### 8. 联系我们

如果您对本隐私权政策有任何疑问，请通过以下方式联系我们：
**电子邮箱：** [xcyebgkob@mozmail.com]

---


## <span id="en">English Version</span>

### 1. Introduction
**ProxySwitch** ("we", "us", or "our") is committed to protecting your privacy. This Privacy Policy explains how we handle your data when you use our Chrome Extension.

**The core principle of ProxySwitch is privacy-first: We do not collect, store, or transmit your personal data, browsing history, or traffic data to our own servers.** All processing happens locally on your device or directly between your device and the third-party services you explicitly configure (e.g., GitHub, WebDAV).

### 2. Data Collection and Usage

We do not collect any Personal Identifiable Information (PII). Here is a breakdown of how data is handled:

*   **Browsing History & URLs:**
    *   The extension accesses your active tab's URL **locally** solely to determine which proxy rule applies (e.g., Auto, Global, or Direct) and to update the extension icon's status.
    *   **This data never leaves your browser** and is never sent to us or any third parties for tracking purposes.
*   **Proxy Configurations & Rules:**
    *   Your server lists, custom rules (user rules/whitelists), and settings are stored in your browser's **Local Storage** (`chrome.storage.local`).
*   **Authentication Tokens (Cloud Backup):**
    *   If you use the "Cloud Backup" feature, your GitHub Token or WebDAV credentials are saved locally in your browser. They are used **strictly** to authenticate with the service provider you chose. We do not have access to these credentials.

### 3. Cloud Backup & Restore (User-Initiated)

The extension includes a "Cloud Backup" feature that allows you to sync your configurations across devices. This is an **optional** feature.

*   **GitHub Gist / WebDAV:** If you choose to use this feature, your configuration data (which is encoded) is transmitted directly from your browser to **your own** GitHub Gist or WebDAV server.
*   **No Intermediary:** This transmission occurs directly. Does not pass through any servers owned by ProxySwitch developers.

### 4. Permissions Usage

We request the minimum permissions necessary for the extension to function:

*   **`proxy`**: Required to modify the browser's proxy settings (System, Direct, PAC, or Fixed servers) as requested by the user.
*   **`storage`**: Required to save your settings and rules locally on your device.
*   **`tabs`**: Required to detect the URL of the current tab to display the routing status (e.g., "Proxied" or "Direct") in the popup interface.
*   **`host_permissions` (`<all_urls>` / `http://*/*`, `https://*/*`)**:
    *   To download the GFWList rule set from public repositories (e.g., GitHub or jsDelivr).
    *   To perform latency tests on your proxy servers (connecting to target URLs).
    *   To communicate with the GitHub API or your WebDAV server for the Backup/Restore feature.

### 5. Third-Party Services

*   **GFWList:** The extension may download public rule lists from GitHub or CDNs. This is a read-only operation.
*   **Cloud Providers:** If you use the backup feature, you are subject to the privacy policies of the respective providers (e.g., GitHub Privacy Statement).

### 6. Data Security

Since we do not collect your data, there is no risk of your data being breached from our servers. For data stored locally or on your cloud accounts, we use standard encryption or encoding (Base64) where applicable to obfuscate the configuration files.

### 7. Changes to This Policy

We may update this Privacy Policy from time to time. If we make significant changes, we will notify users through the extension's update notes or the Chrome Web Store listing.

### 8. Contact Us

If you have any questions about this Privacy Policy, please contact us at:
**Email:** [xcyebgkob@mozmail.com]
