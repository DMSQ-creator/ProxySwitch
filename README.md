# ProxySwitch - Professional Proxy Manager
# 专业的 Chrome 代理切换与规则管理工具

<!-- 动态读取 main 分支 manifest.json 的版本号 -->
![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FDMSQ-creator%2FProxySwitch%2Fmain%2Fmanifest.json&query=%24.version&label=Version&color=blue)
![Manifest](https://img.shields.io/badge/Manifest-V3-green.svg)
![License](https://img.shields.io/badge/license-MIT-orange.svg)

[🇨🇳 中文介绍](#-中文介绍) | [🇺🇸 English Introduction](#-english-introduction)

---

## <span id="cn">🇨🇳 中文介绍</span>

**ProxySwitch** 是一款基于 Chrome Manifest V3 架构开发的轻量级、高性能代理管理扩展。它支持自动分流（PAC）、全局代理和直连模式，并内置了强大的规则管理和云端备份功能。

### ✨ 主要功能

*   **🛡️ 多模式切换**：支持自动分流 (PAC)、全局代理、直接连接、系统代理四种模式一键切换。
*   **🤖 智能分流**：
    *   **GFWList 支持**：一键订阅并更新 GFWList 规则。
    *   **自动识别**：根据域名自动判断走代理还是直连。
    *   **黑白名单**：支持自定义强制代理域名（黑名单）和强制直连域名（白名单）。
    *   **本站直连**：在弹窗一键将当前域名及其子域名加入白名单，加载中的网页也可操作；支持撤销，保留原有代理规则。白名单仅在自动分流模式下生效。
*   **🔎 当前页面请求诊断**：主动开启后，按域名查看当前页面的请求、规则线路与错误；支持批量临时试用代理/直连、撤销及保存正式规则。弹窗用于快速处理，详细页用于查看完整记录。
*   **☁️ 云端备份**：
    *   支持 **GitHub Gist** 备份（推荐，免费且稳定）。
    *   支持 **WebDAV** 备份（坚果云、Nextcloud 等）。
    *   配置以可读 JSON 保存到您自己的私有 GitHub Gist 或 WebDAV；同步凭据不会写入备份，但配置文件不会被额外加密，请使用可信服务和 HTTPS。
*   **⚡ 高级特性**：
    *   支持 SOCKS5 和 HTTP/HTTPS 代理协议。
    *   内置服务器延迟测试。
    *   深色模式 (Dark Mode) 支持。
    *   完全适配 Chrome Manifest V3，性能更优，内存占用更低。

### 📂 目录结构

确保你的本地文件结构如下所示，否则扩展无法加载：

```text
ProxySwitch/
├── manifest.json        # 核心配置文件
├── README.md            # 项目说明
├── assets/              # 图标资源文件夹
│   └── icon.png         # 请确保放入一个 icon.png (推荐 128x128)
├── html/                # HTML 页面
│   ├── popup.html
│   └── options.html
└── js/                  # JavaScript 逻辑
    ├── background.js
    ├── popup.js
    └── options.js
```

### 🚀 安装指南

由于本项目是源代码，你需要通过“加载已解压的扩展程序”来安装：

1.  **获取代码**
    使用 Git 克隆仓库或直接下载 ZIP 包解压：
    ```bash
    git clone https://github.com/DMSQ-creator/ProxySwitch.git
    ```

2.  **打开扩展管理页**
    在 Chrome 地址栏输入以下地址并回车：
    ```text
    chrome://extensions/
    ```

3.  **开启开发者模式**
    点击页面右上角的开关，开启 **开发者模式 (Developer mode)**。

4.  **加载扩展**
    点击左上角的 **加载已解压的扩展程序 (Load unpacked)** 按钮。

5.  **选择文件夹**
    在弹出的窗口中，选择包含 `manifest.json` 的 `ProxySwitch` 文件夹即可。

### 📖 使用说明

1.  **配置服务器**：
    *   安装后，点击扩展图标或右键选择“选项”。
    *   进入“服务器配置”，添加你的 SOCKS5 或 HTTP 代理服务器地址。
    *   点击“测试延迟”确保连通性。

2.  **切换模式**：
    *   点击浏览器右上角的扩展图标打开 Popup 面板。
    *   **🤖 自动分流**：根据规则判断（推荐日常使用）。
    *   **🚀 全局代理**：所有流量通过代理。
    *   **🛡️ 直接连接**：所有流量不走代理。
    *   **💻 系统代理**：操作系统统一设置代理，应用遵循系统配置。

3.  **添加规则**：
    *   在浏览网页时，如果遇到页面加载缓慢，打开 Popup 面板。
    *   根据当前域名状态，点击“加入代理列表”即可将该域名永久加入规则。

4.  **云端备份**：
    *   在设置页面的“云端备份”中，填入 GitHub Token 或 WebDAV 信息即可备份/恢复配置。

### 🔎 排查页面的跨域请求

页面可能同时使用主站、验证码、登录、接口及静态资源等多个域名。自动分流按每个请求的目标域名匹配规则，不会让第三方域名自动跟随主站。

1. 在需要排查的普通 HTTP/HTTPS 页面打开扩展，点击“当前页面请求”。首次使用需允许可选的请求观察权限；默认不采集，无痕标签页不支持。
2. 点击重新加载并采集。扩展仅观察选中的标签页，每次最多采集 60 秒；开启前的历史请求无法补查。页面诊断绑定原标签页，打开详细页不会更换采集目标。
3. 查看全部域名，或筛选与主站规则线路不同的域名。勾选要验证的域名，选择代理或直连，然后临时应用并回网页验证。试用需要自动分流模式，不会替您切换代理模式；遇到已有手动规则冲突时需先处理冲突。
4. 有效时保存为正式规则，无效时撤销。试用最长 10 分钟，撤销只删除本次试用，不还原或覆盖期间修改的正式配置。

**请注意：**

* 显示的是依据 ProxySwitch 规则计算的线路，并非对实际出口 IP 的探测；代理回退及 Clash 内部规则也可能影响最终线路。
* 请求失败不一定需要代理，HTTP 成功也不代表验证码或登录验证通过。分流不同只是排查线索，不会自动添加规则。
* **域名规则不是按标签页隔离的：试用与保存都会影响其他页面对同一域名及其子域名的访问。**
* 采集最多保留 200 个域名，并限制进行中请求数量。记录仅包含域名、资源类型、计数、HTTP 状态与错误等摘要，不保存完整 URL、Cookie 或请求正文；本地记录在 30 分钟后清理，也可手动清除。
* 采集记录与临时试用不参加导出或云备份；您主动保存的正式规则遵循原有的配置备份/同步行为。

---

## <span id="en">🇺🇸 English Introduction</span>

**ProxySwitch** is a lightweight, high-performance proxy management extension built on the Chrome Manifest V3 architecture. It supports Auto Switch (PAC), Global Proxy, and Direct connection modes, featuring powerful rule management and cloud backup capabilities.

### ✨ Key Features

*   **🛡️ Multi-Mode Switching**: One-click switching between Auto Switch (PAC), Global Proxy, Direct Connection, and System Proxy modes.
*   **🤖 Smart Routing**:
    *   **GFWList Support**: Subscribe to and update GFWList rules with one click.
    *   **Auto Detection**: Automatically decides whether to proxy or connect directly based on the domain.
    *   **Black/White Lists**: Support for custom user rules (blacklist for forced proxy, whitelist for forced direct).
    *   **Direct for This Site**: Add the current hostname and its subdomains to the direct list from the popup, even while a page is loading. Undo removes the entry while keeping existing proxy rules. Direct-list rules apply only in Auto mode.
*   **🔎 Page Request Diagnostics**: Start a capture to inspect the current page's request domains, predicted rule routes, and errors. Try proxy/direct rules in batches, undo a trial, or save permanent rules. Use the popup for quick changes and the detailed view for the full record.
*   **☁️ Cloud Backup**:
    *   Supports **GitHub Gist** backup (Recommended).
    *   Supports **WebDAV** backup (Nextcloud, etc.).
    *   Configurations are stored as readable JSON in your own private GitHub Gist or WebDAV service. Sync credentials are excluded, but the backup is not additionally encrypted; use a trusted service and HTTPS.
*   **⚡ Advanced Features**:
    *   Supports SOCKS5 and HTTP/HTTPS protocols.
    *   Built-in server latency testing.
    *   Dark Mode support.
    *   Fully optimized for Chrome Manifest V3 for better performance and lower memory usage.

### 📂 Directory Structure

Ensure your local file structure matches the following to avoid loading errors:

```text
ProxySwitch/
├── manifest.json        # Core configuration file
├── README.md            # Project documentation
├── assets/              # Icon resources
│   └── icon.png         # Ensure an icon.png exists (128x128 recommended)
├── html/                # HTML pages
│   ├── popup.html
│   └── options.html
└── js/                  # JavaScript logic
    ├── background.js
    ├── popup.js
    └── options.js
```

### 🚀 Installation Guide

Since this is the source code, you need to install it via "Load unpacked":

1.  **Download Code**
    Clone the repository using Git or download the ZIP file:
    ```bash
    git clone https://github.com/DMSQ-creator/ProxySwitch.git
    ```

2.  **Open Extensions Page**
    Type the following in your Chrome address bar:
    ```text
    chrome://extensions/
    ```

3.  **Enable Developer Mode**
    Toggle on **Developer mode** in the top right corner.

4.  **Load Extension**
    Click the **Load unpacked** button in the top left corner.

5.  **Select Folder**
    Select the `ProxySwitch` folder containing the `manifest.json` file.

### 📖 Usage

1.  **Configure Server**:
    *   After installation, click the extension icon or right-click and select "Options".
    *   Go to "Server Configuration" and add your SOCKS5 or HTTP proxy server.
    *   Click "Test Latency" to ensure connectivity.

2.  **Switch Modes**:
    *   Click the extension icon to open the Popup panel.
    *   **🤖 Auto Switch**: Routes traffic based on rules (Recommended).
    *   **🚀 Global Proxy**: Routes all traffic through the proxy.
    *   **🛡️ Direct**: Connects directly without proxy.
    *   **💻 System Proxy**: Follows the operating system's proxy settings.

3.  **Add Rules**:
    *   While browsing, if a page loads slowly, open the Popup panel.
    *   Click "Add to Proxy List" to permanently add the current domain to your user rules.

4.  **Cloud Backup**:
    *   In the Options page under "Cloud Backup", enter your GitHub Token or WebDAV details to backup or restore your configuration.

### 🔎 Diagnose Cross-Domain Page Requests

A page may use separate domains for the main site, challenges, sign-in, APIs, and static resources. Auto mode matches each request's destination domain; third-party domains do not automatically follow the main site's route.

1. Open the extension on the normal HTTP/HTTPS page you want to inspect and select **Current page requests**. First use requires the optional request-observation permission. Capture is off by default, and incognito tabs are not supported.
2. Reload and capture. Only the selected tab is observed, for up to 60 seconds per capture. Earlier requests cannot be recovered. The detailed view stays bound to the original tab instead of becoming the capture target itself.
3. Inspect all domains or filter for routes that differ from the main site's. Select domains, choose proxy or direct, and apply a temporary trial before returning to the page to verify it. Trials require Auto mode and do not switch your proxy mode for you. Resolve existing manual-rule conflicts first.
4. Save working changes as permanent rules, or undo the trial. Trials expire after at most 10 minutes. Undo removes only the trial and does not restore an older snapshot of your configuration.

**Important limits:**

* Routes are predictions from ProxySwitch rules, not measurements of the actual exit IP. Proxy fallback and Clash's own rules may affect the final connection.
* A failed request does not necessarily need a proxy, and an HTTP success does not prove a challenge or sign-in succeeded. Different routes are clues, not automatic rule recommendations.
* **Domain rules are not tab-isolated: trials and saved rules also affect other pages requesting the same domain and its subdomains.**
* Captures retain at most 200 domains and bound the number of in-flight requests. Local summaries contain domains, resource types, counts, HTTP statuses, and errors—not full URLs, cookies, or request bodies. Records are cleaned up after 30 minutes and can be cleared manually.
* Capture records and temporary trials are excluded from configuration export and cloud backup. Permanent rules you explicitly save follow the existing configuration backup/sync behavior.

---

## 📝 License

This project is open-sourced under the MIT License.
