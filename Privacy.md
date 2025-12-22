# ProxySwitch 隐私政策

**最后更新日期：** 2025 年 12 月 22 日

**生效日期：** 2025 年 12 月 22 日

### 1. 简介
ProxySwitch（以下简称“本扩展”）是一款旨在帮助用户管理代理设置和切换规则的 Chrome 浏览器扩展程序。我们要重视您的隐私，并致力于保护您的个人数据。**我们绝不会在我们的服务器上收集、存储或分享您的浏览记录或个人信息。**

### 2. 数据收集与使用
本扩展完全在您的本地设备上运行。我们通过以下方式处理数据：

*   **代理配置：** 您输入的代理服务器详情（IP、端口、用户名、密码）仅存储在您的浏览器本地 (`chrome.storage.local`)，并仅用于通过 `chrome.proxy` API 配置浏览器的网络连接。
*   **浏览活动 (标签页与 URL)：** 我们申请 `tabs` 权限以获取当前活动标签页的 URL。这**仅用于本地**执行以下操作：
    1.  检查当前 URL 是否匹配您配置的规则（如 GFWList）。
    2.  更新扩展图标颜色，以指示当前网站是否正在使用代理。
    *   **我们不会保存您的浏览历史。**
    *   **我们不会将您的浏览历史上传至任何服务器。**
*   **外部请求 (主机权限)：** 我们申请访问外部 URL 的权限（`<all_urls>`）。这仅在以下情况使用：
    1.  **您**主动点击更新，从您指定的远程 URL 下载 GFWList 规则列表。
    2.  **您**开启云同步功能，向您自己的 WebDAV 服务器或 GitHub Gist 上传/下载配置。
    *   本扩展仅会连接到**您指定**的服务器。

### 3. 云端同步
如果您选择使用“云同步”功能（GitHub Gist 或 WebDAV）：
*   您的认证令牌（如 GitHub Token、WebDAV 密码）仅存储在您的本地设备上。
*   这些凭据会**直接**发送给服务提供商（GitHub 或您的 WebDAV 服务器）以进行身份验证。
*   **我们（ProxySwitch 的开发者）无法获取您的 Token、密码或同步的数据。**

### 4. 第三方服务
根据您的配置，本扩展可能会与以下第三方服务交互：
*   **GitHub：** 如果您使用 Gist 同步或从 GitHub 获取规则。
*   **用户自定义的 WebDAV 服务器：** 如果您配置了 WebDAV 同步。
*   **规则列表提供方：** 您输入的用于下载代理规则的任何 URL（如 jsDelivr）。
请参阅这些相应服务的隐私政策。

### 5. 数据安全
您的所有设置都存储在浏览器的本地存储沙盒中。在进行同步时，数据将通过 HTTPS（前提是您使用的服务支持）传输以确安全性。

### 6. 联系我们
如果您对本隐私政策有任何疑问，请通过以下方式联系我们：
**xcyebgkob@mozmail.com**

---

# Privacy Policy for ProxySwitch / ProxySwitch 隐私政策

**Last Updated:** December 22, 2025
**Effective Date:** December 22, 2025


### 1. Introduction
ProxySwitch ("we", "our", or "the extension") is a Chrome browser extension designed to help users manage proxy settings and switch rules. We value your privacy and are committed to protecting your personal data. **We do not collect, store, or share your browsing history or personal information on our servers.**

### 2. Data Collection and Usage
The extension operates locally on your device. We handle data in the following ways:

*   **Proxy Configuration:** The proxy server details (IP, port, username, password) you input are stored locally in your browser (`chrome.storage.local`) and are used solely to configure the browser's proxy settings via the `chrome.proxy` API.
*   **Browsing Activity (Tabs & URLs):** We request the `tabs` permission to access the URL of the active tab. This is used **strictly locally** to:
    1.  Check if the current URL matches your configured rules (e.g., GFWList).
    2.  Update the extension icon color to indicate whether the current site is being proxied.
    *   **We do NOT save your browsing history.**
    *   **We do NOT upload your browsing history to any server.**
*   **External Requests (Host Permissions):** We request access to fetch data from external URLs (`<all_urls>` permission). This is used only when:
    1.  **You** initiate a request to update the GFWList (Rule List) from a remote URL you specified.
    2.  **You** enable Cloud Sync to upload/download configurations to/from your own WebDAV server or GitHub Gist.
    *   The extension only connects to the servers **you define**.

### 3. Cloud Synchronization
If you choose to use the "Cloud Sync" feature (GitHub Gist or WebDAV):
*   Your authentication tokens (e.g., GitHub Token, WebDAV password) are stored locally on your device.
*   These credentials are sent **directly** to the service provider (GitHub or your WebDAV server) to authenticate requests.
*   **We (the developers of ProxySwitch) do not have access to your tokens, passwords, or synchronized data.**

### 4. Third-Party Services
The extension may interact with the following third-party services based on your configuration:
*   **GitHub:** If you use GitHub Gist for sync or fetch rules from GitHub.
*   **User-defined WebDAV Servers:** If you configure WebDAV sync.
*   **Rule List Providers:** Any URL you input to download proxy rules (e.g., jsDelivr).
Please refer to the privacy policies of these respective services.

### 5. Data Security
All your settings are stored within your browser's local storage sandbox. When syncing, data is transmitted over HTTPS (provided the services you use support it) to ensure security.

### 6. Contact Us
If you have any questions about this Privacy Policy, please contact us at:
**xcyebgkob@mozmail.com**
