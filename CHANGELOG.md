# 更新说明
## v7.8.5
- 修复：`generateUUID` 兼容性 fallback 增加 `crypto` 对象存在性检查，并添加 `Math.random` 兜底方案
- 修复：Service Worker 中 `OffscreenCanvas` 不可用时不再尝试调用 `document.createElement`（Service Worker 无 DOM），改为跳过图标渲染并记录警告

## v7.8.4
- 修复：`renderServerList` 空列表时消除递归调用风险，改为直接赋值后继续渲染

## v7.8.3
- 修复：重置扩展时如果清空存储失败，不再强制重新加载，避免数据丢失

## v7.8.2
- 修复：Popup 弹窗在翻译文本较长或字体较大时内容被截断，添加垂直滚动条支持

## v7.8.1
- 修复：日志复制 fallback 中 `document.execCommand('copy')` 失败时会误显示成功提示，现在正确提示复制失败

## v7.8.0
- 修复：PAC 模式下无可用服务器时自动回退到直连模式，避免残留旧 PAC 规则导致异常代理

## v7.7.9
- 修复：为 `crypto.randomUUID()` 和 `OffscreenCanvas` 添加兼容性 fallback，提升在旧版浏览器/Firefox 中的兼容性

## v7.7.8
- 增强：错误日志支持记录更详细的耗时与超时信息（存储读取、PAC 生成、消息调用等），用于定位“假死/无响应”
- 增强：popup 增加与后台的长连接通道并记录打开/关闭会话，便于追踪 Service Worker 忙碌时段
- 调整：日志保留条数上限提高到 500 条

## v7.7.7
- 修复：找到 popup 假死的根源之一，PAC 模式下页面加载期间 `tabs.onUpdated` 高频触发，后台反复做图标匹配与标签校验，导致 Service Worker 被频繁唤醒并忙住
- 优化：页面加载中只显示默认 PAC 图标，等加载完成后再做一次真实规则匹配，避免点击插件图标时后台仍在高频计算
- 优化：仅对当前激活标签页做图标刷新，并在标签关闭时清理挂起定时器

## v7.7.6
- 修复：页面未加载完成时点击插件图标，popup 偶发无响应/假死的问题（减少后台 PAC 刷新/生成路径的全量读取，降低阻塞）
- 优化：后台 REFRESH_PROXY 增加回包，提升 Manifest V3 Service Worker 处理期间的稳定性
- 调整：错误日志时间显示为本地时间

- 修复：页面加载中打开 popup 时不再读取/匹配 GFWList 超大规则，避免 popup 打不开（页面加载完成后再打开可得到完整匹配结果）
