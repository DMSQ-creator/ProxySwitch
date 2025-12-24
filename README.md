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
*   **☁️ 云端备份**：
    *   支持 **GitHub Gist** 备份（推荐，免费且稳定）。
    *   支持 **WebDAV** 备份（坚果云、Nextcloud 等）。
    *   配置文件经过 Base64 混淆处理，保护隐私。
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

---

## <span id="en">🇺🇸 English Introduction</span>

**ProxySwitch** is a lightweight, high-performance proxy management extension built on the Chrome Manifest V3 architecture. It supports Auto Switch (PAC), Global Proxy, and Direct connection modes, featuring powerful rule management and cloud backup capabilities.

### ✨ Key Features

*   **🛡️ Multi-Mode Switching**: One-click switching between Auto Switch (PAC), Global Proxy, Direct Connection, and System Proxy modes.
*   **🤖 Smart Routing**:
    *   **GFWList Support**: Subscribe to and update GFWList rules with one click.
    *   **Auto Detection**: Automatically decides whether to proxy or connect directly based on the domain.
    *   **Black/White Lists**: Support for custom user rules (blacklist for forced proxy, whitelist for forced direct).
*   **☁️ Cloud Backup**:
    *   Supports **GitHub Gist** backup (Recommended).
    *   Supports **WebDAV** backup (Nextcloud, etc.).
    *   Configuration files are obfuscated with Base64 for privacy.
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

---

## 📝 License

This project is open-sourced under the MIT License.
