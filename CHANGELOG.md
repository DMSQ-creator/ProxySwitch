# 更新说明 / Changelog

## v7.14.0 — 2026-10-14

### 中文

- 新增：页面请求支持“一次开启、之后自动记录”。首次需明确同意并授予可选权限；升级后的旧权限不会自动开启记录。开启后，普通网页的请求域名与结果按标签页自动汇总，打开面板即可查看，不必每次重新采集或刷新网页。
- 体验：默认展示全部域名，优先呈现异常请求；可筛选网络错误、HTTP 异常及分流不同。继续支持勾选后一键添加代理 / 直连、安全撤销和可选临时试用；不自动添加规则、切换模式或刷新原页面。
- 完整性：包含 HTTP/HTTPS 与 WebSocket（WS/WSS）握手，后台重新唤醒后恢复会话缓存；无法确认的进行中请求标为“未确认”，不误判为失败或一直连接中。仅观察浏览器 API 提供的事件，不读取实时消息，也不能补查开启前的请求。
- 隔离：每个标签页仅保留当前页面记录，导航、关闭、权限撤销及关闭记录时清理对应数据；旧页面迟到事件和过期操作不会改写新页面记录。关闭遇到存储错误时停止采集并保留明确的错误反馈。
- 隐私：自动请求摘要及勾选状态只使用会话存储或内存，不写入长期存储、不进入黑匣子、配置导出或云备份；最后活动后最多保留 30 分钟。限制 20 个标签页、每页 200 / 总计 2000 个域名、1000 个进行中请求及 680 KiB 缓存；不支持无痕页。
- 完善：同步更新中英双语使用说明、隐私政策及 Chrome 商店权限理由，明确自动记录需主动开启、规则线路并非实际出口、请求失败不一定需要代理。
- 验证：699 项自动化测试通过；真实 Chromium 验证 HTTP、WS/WSS 分流、一键添加与撤销、后台停止及唤醒、配置恢复与重置、原 Logo 和草稿保护，并检查四语深浅色及 360 × 600 弹窗布局。
- 兼容性：无新增 API 权限，已有代理配置无需迁移，最低支持 Chrome 95；不支持会话存储的旧浏览器使用有界内存缓存，后台重启可能丢失记录。

### English

- Added **enable once, record automatically thereafter** for Page requests. First use requires explicit consent and the optional permission; an existing grant does not silently enable recording after an upgrade. Normal page requests are summarized per tab before opening the panel, without mandatory captures or page reloads.
- Experience: show all domains by default, prioritizing request problems, with network-error, HTTP-error, and different-route filters. One-click proxy/direct additions, safe undo, and optional trials remain available. Rules, modes, and page reloads are never changed automatically by observation.
- Integrity: includes HTTP/HTTPS and WebSocket (WS/WSS) handshakes and restores session caches after worker wake-up. Unverifiable in-flight requests become **unconfirmed**, not false failures or permanently pending connections. Only browser-provided events are observed; messages and requests from before opt-in are not available.
- Isolation: each tab retains only its current page. Navigation, closure, permission revocation, and disabling recording clear the appropriate data. Late old-page events and stale actions cannot overwrite new-page records. Disabling stops observation immediately and reports storage failures explicitly.
- Privacy: automatic summaries and selections use session storage or bounded memory only, never persistent storage, the fault journal, configuration exports, or cloud backups. Retention is at most 30 minutes after the last activity, bounded to 20 tabs, 200 domains per tab / 2000 overall, 1000 in-flight requests, and 680 KiB. Incognito is excluded.
- Documentation: updated bilingual usage, privacy disclosures, and Chrome Web Store permission justifications. Automatic recording requires opt-in; predicted routes are not actual exits, and a failed request does not necessarily need a proxy.
- Validation: all 699 automated tests passed. Real Chromium checks cover HTTP and WS/WSS routing, one-click addition and undo, worker stop/wake, configuration restore/reset, the original logo and draft protection, plus four-language light/dark layouts and 360 × 600 popups.
- Compatibility: no additional API permissions or configuration migration; Chrome 95 remains supported. Older browsers without session storage use bounded memory and may lose records when the worker restarts.

## v7.13.0 — 2026-10-14

### 中文

- 界面：采用高效紧凑布局，统一弹窗、设置和页面诊断的配色、排版与功能线性图标；保留原 Logo 及工具栏模式图标，不再使用 Emoji 作为操作图标。
- 优化：浅色、深色及跟随系统主题在三个页面保持一致；系统主题变化实时生效，补齐键盘焦点、对比度及窄窗口布局。
- 弹窗：模式选择与本站规则分开呈现，代理 / 直连并列；网页仍在加载时可以设置规则，状态随原标签页更新。明确区分规则预计线路与实际网络出口。
- 精简：弹窗首屏减少重复标题、域名和说明；路线图标、彩色域名与详情入口同一行显示，不再重复展示代理 / 直连状态文字，颜色对应工具栏的规则来源。完整域名及规则说明可悬停或打开详情查看，辅助阅读仍保留状态文字；长域名省略显示，不挤压图标与详情按钮。临时代理、移除与管理收进本站规则标题旁的“更多”，以纵向列表展开；页面请求与设置并排。保留原 Logo 和清晰字号，失败、上级规则覆盖及非自动模式提醒继续直接显示。
- 新增：本站精确直连规则可一键改为本站代理，一次校验并保存两类规则；上级直连规则仍需在规则管理调整，不扩大删除范围或自动切换模式。
- 修复：页面请求诊断补齐 WebSocket（WS/WSS）主机授权、域名与握手状态，实时后台域名可直接勾选并复用试用、撤销和保存规则。列表提供轻量类型提示，握手成功不等同于业务已连接；不读取消息、请求头、正文或完整 URL，采集仍需主动开启并限定原标签页。
- 简化：页面请求默认支持勾选域名后直接添加代理或直连规则，临时试用保留为可选操作，试用后的保存也不再要求额外勾选与二次确认。新增批次提供限时安全撤销，保留原规则和后续编辑；直接添加与撤销不自动刷新原网页或切换模式。保存及代理应用状态分别反馈，失败可重试，重复点击或迟到回复不重复写入。
- 设置：订阅地址改为明确保存，连续输入不再逐字写入或丢失焦点；保存失败、后台更新与切换设置分区不会冲掉未保存草稿。
- 修复：GFWList“保存地址”按钮不再被长地址输入框挤压或拆字换行；输入框与按钮高度一致，窄窗口下整行换位。
- 修复：切换语言时保留其他栏目的草稿，确认保存或取消后再刷新；中文输入法选字不会误提交服务器表单。
- 规则：提供明确的编辑、保存、取消及 Enter / Esc 操作；删除或清空后可撤销最近一次操作，其他页面修改后不会被旧撤销记录覆盖。
- 反馈：失败提示持续显示，云操作结果可查看及重试；操作反馈不会重复堆叠，待保存时仍可浏览其他设置。
- 修复：编辑云备份凭据后，首次点击上传或恢复不会再被自动保存禁用按钮而吞掉；增加“保存设置”，上传 / 恢复也会先统一保存当前草稿。自动备份选项需保存后生效。
- 验证：619 项自动化测试通过；真实 Chromium 验证请求诊断、配置恢复及撤销，并检查加载中操作、草稿保护、规则编辑和云失败重试。真实 HTTP、WS 与 TLS/WSS 覆盖跨域采集、长连接握手终结、错误、一键永久代理/直连、安全撤销、应用失败重试、可选试用及私密消息不落盘。检查四语深浅色弹窗、详情 / 更多及诊断按钮的键盘操作、200 域名计数与重要提醒；默认首屏和例外状态无需滚动，主动展开的长说明可纵向滚动。设置页在 380 / 640 / 760 CSS 像素宽度下无横向裁切，并检查四语“保存地址”按钮在宽窄窗口下的完整显示与对齐。
- 兼容性：现有配置无需迁移，不新增 API 权限；主机授权仅补充 WS/WSS，不扩大到文件或其他协议。页面诊断仍只在主动开启时采集有限元数据，不自动后台采集。最低支持 Chrome 95。

### English

- UI: a compact layout unifies popup, Options, and page diagnostics with consistent colors, typography, and line icons. The original logo and toolbar mode icons are retained; action icons no longer use Emoji.
- Improved: Light, Dark, and live System themes are consistent across all three pages, with keyboard focus, readable contrast, and narrow-window layouts.
- Popup: mode selection and site rules have separate sections with side-by-side proxy/direct actions. Rules remain available during page loading, and status follows the original tab. Predicted rule routing is distinguished from the actual network exit.
- Simplified: reduced repeated popup headings, hostnames, and explanations. The route icon, colored hostname, and details control share one row without a duplicate proxy/direct label; colors correspond to the toolbar's rule sources. The full hostname and rule explanation remain available on hover and in details, with textual status retained for assistive reading. Long hostnames are shortened without squeezing the icon or details button. **More**, beside the site-rule heading, expands a vertical list of temporary proxy, removal, and management actions. Page requests and Settings share a row. The original logo and readable font sizes remain; failures, inherited-rule overrides, and non-Auto-mode reminders stay visible.
- Added: replace an exact site's direct entry with a proxy rule in one validated write. Inherited parent direct rules still require Rule Management; quick actions do not broaden deletions or change the selected mode.
- Fixed: page diagnostics now include WebSocket (WS/WSS) host authorization, domains, and handshake results. Real-time backend domains can be selected for the existing trial, undo, and permanent-rule workflow. A subtle type label identifies these connections; a successful handshake does not mean the application is connected. Messages, headers, bodies, and full URLs are not read or stored. Captures remain user-initiated and source-tab scoped.
- Simplified: select request domains to add proxy/direct rules directly. Temporary trials remain optional, and saving a trial no longer requires an extra checkbox or confirmation screen. Time-limited addition undo preserves existing rules and subsequent edits. Direct addition/undo never reloads the source page or switches modes automatically. Saving and proxy application have separate feedback and retry, with duplicate clicks and late replies protected against repeated writes.
- Options: subscription URLs now have an explicit save action. Typing no longer writes each keystroke or loses focus; failures, background updates, and section changes preserve unsaved drafts.
- Fixed: long GFWList URLs no longer squeeze or wrap the **Save URL** button caption. The input and button have matching heights and reflow as whole controls in narrow windows.
- Fixed: language changes preserve drafts in other sections and defer refresh until they are saved or canceled. Input-method composition keys no longer submit the server form prematurely.
- Rules: explicit edit/save/cancel controls with Enter / Esc support. Undo the latest deletion or clear operation without overwriting changes made by another page.
- Feedback: failures remain visible, cloud results can be reviewed and retried, and feedback does not accumulate. Other settings remain readable while a save is pending.
- Fixed: after editing backup credentials, the first upload/restore click is no longer swallowed by blur-triggered saving. Added **Save settings**; upload/restore also commit current drafts first. Automatic-backup choices take effect after saving.
- Validation: all 619 automated tests passed. Real Chromium verified request diagnostics, restore/undo, loading-page actions, draft protection, rule editing, and cloud failure retry. Real HTTP, WS, and TLS/WSS checks cover cross-domain capture, completed handshakes with sockets kept open, errors, one-click permanent proxy/direct rules, safe undo, application-failure retry, optional trials, and no persisted private messages. Four-language light/dark popup checks cover keyboard disclosures and diagnostic actions, 200-domain selection counts, and visible critical notices. Default and exceptional home states fit without scrolling; user-expanded long explanations remain vertically scrollable. Options reflows without horizontal clipping at 380 / 640 / 760 CSS-pixel widths, with four-language checks for complete, aligned Save URL buttons in wide and narrow windows.
- Compatibility: no configuration migration or additional API permissions. Host access adds only WS/WSS, not file or other schemes. Page diagnostics still collect only limited metadata after the user starts a capture, with no automatic background capture. Chrome 95 remains the minimum supported version.

## v7.12.0 — 2026-10-13

### 中文

- 修复：配置保存与代理应用改为串行处理，忙时重新读取最新规则；模式切换也通过后台队列执行，避免旧操作迟到覆盖新选择。失败或超时不再误报成功，未完成的写入保持隔离。
- 修复：后台维护不再接管其他扩展或浏览器策略的代理设置；监听实际模式变化与代理异常，更新图标并在弹窗提示。重置配置前先释放本扩展的代理设置，释放失败时保留配置。
- 修复：一键添加代理和临时规则使用当前域名及其子域名，不再猜测上级域名；共享父规则需要到规则管理调整，一键移除不会删除父域名或白名单。
- 修复：HTTPS 代理在自动分流中保留 TLS 协议，公网 IPv6 不再误判本地；旧临时规则仅在本次浏览器会话内有效，后台唤醒不会清空，但浏览器启动时清理，云备份不再同步临时规则。
- 新增：云恢复预览，明确列出覆盖和清空的字段；恢复前保存一份本地撤销快照，恢复后发生新编辑时拒绝覆盖。导入和恢复均执行字段、规则及服务器校验。
- 优化：自动备份保留待上传标记，上传期间的新编辑会补传，后台重启后继续检查；网络操作有可取消超时。远程 WebDAV 要求 HTTPS，拒绝公开 Gist，备份不包含凭据、诊断或本地撤销数据。
- 修复：正常云操作不再套用本地操作的 300 毫秒性能警告阈值；黑匣子仍保留耗时与结果，真正失败和超时继续报警。
- 界面：页面诊断区分网络错误和 HTTP 异常；延迟测试明确为当前浏览器线路测试。补齐键盘操作、保存/应用状态和四语提示，保持现有配色。
- 开发：新增并发、坏数据、失败和迟到写入回归测试，以及 Windows/Linux 自动检查、语言与版本一致性检查和真实 Chromium 冒烟检查。
- 验证：357 项自动化测试全部通过；真实 Chromium 验证诊断分流、导入、恢复取消、空列表恢复、撤销、备份数据范围、重置释放代理以及中英文和深浅色界面；模拟较慢云请求，确认普通耗时记录不会触发警告。

### English

- Fixed: configuration writes and proxy updates are serialized and reread the latest rules. Mode changes share the worker queue, so late operations cannot overwrite newer choices. Failures and timeouts no longer report success; unresolved writes remain isolated.
- Fixed: background maintenance does not take over proxy settings controlled elsewhere. Actual mode changes and proxy errors update icons and popup feedback. Resetting first releases this extension's proxy settings; a failed release preserves the configuration.
- Fixed: one-click proxy and temporary rules target the current hostname and its subdomains, not a guessed parent. Shared parent rules must be managed explicitly; quick removal preserves parent rules and direct-list entries.
- Fixed: Auto mode retains HTTPS proxy transport and handles public IPv6 correctly. Old temporary rules now expire on browser startup, not worker wake, and are excluded from cloud backup.
- Added: cloud restore preview with replacement/clearing details and one local undo snapshot. Later edits prevent a stale restore or undo from overwriting them. Imports and restores validate fields, rules and servers.
- Improved: pending uploads survive worker restarts and edits during an upload are retried. Network operations have abortable timeouts. Remote WebDAV requires HTTPS; public Gists are rejected. Credentials, diagnostics and undo data are excluded from backups.
- Fixed: normal cloud operations no longer use the 300 ms local-operation warning threshold. The black box still records timings and outcomes; actual failures and timeouts remain warnings or errors.
- UI: separate network errors from HTTP errors in diagnostics; label latency tests as current-browser-route tests. Added keyboard support, save/apply feedback and four-language messages without changing the palette.
- Development: added concurrency, invalid-data, failure and late-write regression tests, Windows/Linux CI, language/version checks and a real Chromium smoke test.
- Validation: all 357 automated tests passed. Real Chromium verified diagnostic routing, imports, restore cancellation, empty-list restores, undo, backup data exclusions, proxy release on reset, Chinese/English text and light/dark layouts. A delayed cloud response confirmed that normal timing records do not produce warnings.

## v7.11.0 — 2026-09-28

### 中文

- 新增：弹窗“当前页面请求”入口与详细诊断页；用户主动开启后，按域名查看请求摘要、规则线路、匹配依据和错误，支持筛选与主站分流不同的域名。
- 新增：批量试用代理或直连规则，支持返回网页验证、撤销和保存正式规则；临时试用 10 分钟到期，不自动覆盖冲突的手动规则或切换代理模式。
- 界面：弹窗内快速处理，完整诊断页始终绑定原标签页；支持深浅色及英文、简体中文、西班牙语、俄语，沿用插件语言设置。
- 隐私：请求观察为可选权限，默认不采集；仅采集指定普通标签页，单次最多 60 秒，不支持无痕模式。摘要仅保存在本地，30 分钟后清理，不记录完整 URL、Cookie 或请求正文，不参加配置导出或云备份。
- 说明：规则线路不等于实际出口，HTTP 成功不等于验证通过；临时和正式域名规则均可能影响其他页面对这些域名及其子域名的请求，不保证 Cloudflare 验证通过。
- 兼容性：现有配置无需迁移，最低支持 Chrome 95；新增 `alarms` 用于过期清理，`webRequest` 仅在首次主动采集时申请。
- 验证：174 项自动化测试通过；真实 Chromium 验证跨域请求采集、实际代理转发、撤销、保存以及中英文和深浅色界面。

### English

- Added **Current page requests** in the popup and a detailed diagnostics page. User-initiated captures summarize request domains, predicted routes, matching rules, and errors, with a filter for routes differing from the main site's.
- Added batch proxy/direct trials with return-to-page verification, undo, and permanent rule saving. Trials expire after 10 minutes without silently overriding conflicting manual rules or changing the proxy mode.
- UI: quick actions stay in the popup; the full diagnostics page remains bound to the original tab. Light/dark themes and English, Simplified Chinese, Spanish, and Russian follow the extension's language setting.
- Privacy: request observation uses an optional permission and is off by default. Each capture observes one selected normal tab for up to 60 seconds; incognito is not supported. Local summaries are cleaned up after 30 minutes, exclude full URLs, cookies, and request bodies, and are not included in configuration exports or cloud backups.
- Clarified that predicted routes do not prove the actual exit, and HTTP success does not prove a challenge succeeded. Trial and permanent rules also affect other pages requesting these domains and their subdomains; passing Cloudflare verification is not guaranteed.
- Compatibility: existing settings need no migration; Chrome 95 remains the minimum. Added `alarms` for expiry cleanup; optional `webRequest` access is requested only when the user starts a capture for the first time.
- Validation: all 174 automated tests passed. Real Chromium verified cross-domain capture, actual proxy forwarding, undo, permanent saving, Chinese/English text, and light/dark layouts.

## v7.10.0 — 2026-09-28

### 中文

- 新增：弹窗可一键将当前域名加入直连白名单，网页仍在加载时也可操作；明确展示域名及子域名范围，并支持只撤销白名单、保留原有代理规则
- 修复：Chrome 使用英文、插件选择简体中文时，弹窗部分文字仍为英文；语言包加载完成后重新翻译按钮、提示和动态状态，切回跟随浏览器语言同样生效
- 优化：白名单变更在自动分流模式下刷新 PAC；其他模式只保存规则并提示生效条件，避免误显示已直连或改变当前代理模式
- 修复：代理模式延迟返回时重新校正站点状态；配置临时读取失败时保留已加载的语言、主题和服务器选择
- 完善：白名单保存失败或超时时恢复操作按钮；区分“规则已保存”和“代理刷新尚未确认”，防止误报成功
- 验证：90 项自动化检查通过；在英文 Chromium 中验证简体中文显示、语言切换、白名单添加与撤销、实际 PAC 分流及浅色/深色界面
- 兼容性：现有配置无需迁移，未新增权限；最低支持 Chrome 95

### English

- Added a one-click **Direct for this site** button in the popup, available even while the page is loading. The popup shows the hostname and subdomain scope; undo removes only that hostname's direct-list entry and keeps existing proxy rules.
- Fixed partially English popup text when Chrome uses English and the extension is set to Simplified Chinese. Buttons, tooltips, and dynamic status labels are retranslated when the language pack loads; switching back to the browser language also works.
- Direct-list changes now refresh the active PAC in Auto mode. Other modes save the rule and explain when it applies, without changing the selected proxy mode or claiming the site is already connected directly.
- Fixed stale site status when the proxy mode arrives late. Temporary configuration-read failures now preserve the loaded language, theme, and server selection.
- Improved error handling: failed or timed-out direct-list updates release the action buttons, and the popup distinguishes saved rules from unconfirmed proxy refreshes.
- Validation: all 90 automated checks passed. An English Chromium session also verified Simplified Chinese text, language switching, direct-list add/undo, actual PAC routing, and light/dark layouts.
- Compatibility: existing settings need no migration, no new permissions were added, and Chrome 95 remains the minimum supported version.

## v7.9.0

- 修复：自动分流模式下，网页打不开或仍在加载时点击扩展图标，popup 偶发无响应且 Service Worker 可能显示无效的问题
- 修复：状态图标运行时 Canvas/GPU 像素读取可能卡住 Worker；改为使用构建时生成的静态 RGBA 图标数据，避免图形读取阻塞启动
- 新增：故障黑匣子从 popup 页面和 Worker 执行的最早阶段开始记录，覆盖模块加载、PAC 生成、代理应用、图标更新、popup 握手与界面渲染
- 新增：设置页可一键复制诊断报告；部分浏览器接口超时时仍会输出其他已记录证据，并自动给出 Worker、popup 和握手状态判断
- 优化：本地保留最近 500 条运行事件和 20 次 Worker 启动记录；查看报告不会修改后台诊断存储或额外唤醒 Worker
- 隐私：诊断报告自动隐藏密码、Token 和完整网页 URL，不记录服务器、规则或 PAC 正文
- 安全：配置存储读取失败或超时时，设置页自动进入只读诊断模式，避免空数据覆盖现有配置
- 文档：明确云备份为可读 JSON、不会额外加密，并补充标准 MIT 许可证文件
- 兼容性：明确最低支持 Chrome 95；现有配置无需迁移
- 验证：新增 19 项故障注入与回归测试，覆盖存储、代理、Action API 和 Worker 启动异常场景

## v7.8.8

- 修复：`normalizeSet` 处理 `*.中文域名` 时通配符前缀丢失，IDN 域名转换前先剥离前缀、转换后再拼回
- 修复：PAC 模式下全局图标覆盖标签专用图标，导致图标闪烁或显示错误，现 PAC 模式下由 `updateTabIcon` 统一管理
- 修复：popup 打开瞬间 `currentMode` 默认 `'direct'` 导致模式按钮误高亮闪烁，改为 `null` 等异步结果返回
- 优化：云上传排除 UI 偏好字段（主题、语言等），避免跨设备同步时覆盖本地偏好；`backupVer` 升至 5
- 优化：云下载仅在数据含代理相关键时才刷新 PAC，避免无意义重生成
- 优化：统一 storage 监听器日志为 `PSL.info`，便于诊断页查看
- 优化：`importScripts` 加 try-catch 防御，加载失败时明确报错
- 优化：PAC 脚本生成时对不支持的代理协议记录警告

## v7.8.7

- 优化：将“错误日志”更名为“诊断日志”，避免用户误解为只有报错才记录
- 优化：开关文案改为“记录详细诊断（推荐排查时开启）”，更直观说明用途
- 优化：日志区域新增说明文案，提示用于排查卡顿、无响应、同步失败等问题，点击复制即可发给开发者
- 修复：俄语翻译与中/英/西不一致——标题改为“诊断日志”语义，条数上限从 100 修正为 500

## v7.8.6

- 修复：页面未加载或加载失败时点击插件图标弹窗卡死的问题——语言包 fetch 改为非阻塞加载，init 流程增加 3 秒超时兜底
- 修复：页面加载中 `tab.url` 可能为空导致域名获取失败，新增 `tab.pendingUrl` 备选方案
- 修复：后台 `refreshCacheAndIcon` 和 `updateCacheAndApply` 在 `isApplyingProxy` 锁住时无限重试，现加上限（约 1 秒）并强制解锁
- 修复：添加/移除规则按钮在操作期间未禁用，连续点击可能触发多个并发存储写入，现已加防重复点击保护
- 修复：`chrome.tabs.query` 回调缺少 `lastError` 检查，异常时可能导致弹窗无响应

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

- 修复：网页处于加载中、超时或打不开时，popup 不再读取规则或预热 PAC，避免点击插件图标时触发额外后台计算
- 修复：后台在标签页 `loading` 状态下不再更新图标，只在页面完成加载后再刷新一次，进一步切断“页面卡住时扩展也跟着假死”的链路
- 优化：popup 的配置变化监听增加防抖，避免高频 storage 变更导致反复重渲染
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
