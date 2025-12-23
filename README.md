# ProxySwitch - Professional Proxy Manager
# 专业的 Chrome 代理切换与规则管理工具

![Version](https://img.shields.io/badge/version-7.6.0-blue.svg)
![Manifest](https://img.shields.io/badge/Manifest-V3-green.svg)

**ProxySwitch** 是一款基于 Chrome Manifest V3 架构开发的轻量级、高性能代理管理扩展。它支持自动分流（PAC）、全局代理和直连模式，并内置了强大的规则管理和云同步功能。

## ✨ 主要功能 (Features)

*   **🛡️ 多模式切换**：支持自动分流 (PAC)、全局代理、直接连接三种模式一键切换。
*   **🤖 智能分流**：
    *   **GFWList 支持**：一键订阅并更新 GFWList 规则。
    *   **自动识别**：根据域名自动判断走代理还是直连。
    *   **黑白名单**：支持自定义强制代理域名（黑名单）和强制直连域名（白名单）。
*   **☁️ 云端同步**：
    *   支持 **GitHub Gist** 同步（推荐）。
    *   支持 **WebDAV** 同步（坚果云、Nextcloud 等）。
    *   配置文件经过 Base64 混淆处理，保护隐私。
*   **⚡ 高级特性**：
    *   支持 SOCKS5 和 HTTP 代理协议。
    *   内置服务器延迟测试。
    *   深色模式 (Dark Mode) 支持。
    *   完全适配 Chrome Manifest V3，性能更优，内存占用更低。

## 📂 目录结构 (Directory Structure)

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

## 🚀 安装指南 (Installation)

由于本项目是源代码，你需要通过“加载已解压的扩展程序”来安装：

1.  **下载代码**：Clone 本仓库或下载 ZIP 包并解压。
2.  **打开扩展管理**：在 Chrome 地址栏输入 `chrome://extensions/`。
3.  **开启开发者模式**：打开右上角的“开发者模式 (Developer mode)”开关。
4.  **加载扩展**：点击左上角的“加载已解压的扩展程序 (Load unpacked)”。
5.  **选择文件夹**：选择包含 `manifest.json` 的 `ProxySwitch` 文件夹。

## 📖 使用说明 (Usage)

1.  **配置服务器**：
    *   安装后，点击扩展图标或右键选择“选项”。
    *   进入“服务器配置”，添加你的 SOCKS5 或 HTTP 代理服务器地址。
    *   点击“测试延迟”确保连通性。

2.  **切换模式**：
    *   点击浏览器右上角的扩展图标打开 Popup 面板。
    *   **🤖 自动分流**：根据规则判断（推荐日常使用）。
    *   **🚀 全局代理**：所有流量通过代理。
    *   **🛡️ 直接连接**：所有流量不走代理。

3.  **添加规则**：
    *   在浏览网页时，如果遇到页面加载缓慢，打开 Popup 面板。
    *   根据当前域名状态，点击“加入代理列表”即可将该域名永久加入规则。

4.  **云同步**：
    *   在设置页面的“云端同步”中，填入 GitHub Token 或 WebDAV 信息即可备份配置。

## 📝 License

本项目采用 MIT 许可证开源。
