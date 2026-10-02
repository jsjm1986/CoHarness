# Agent Note: rc1 client-lane audit

Status: proposed

[English](2026-09-30-rc1-client-lane-audit.md) | 中文

## Problem

上游 `v0.2.0-rc1` 重建了客户端通道。六个新的 `packages/api/*` 控制器(`session-controller`、`workspace-controller`、`settings-controller`、`job-controller`、`workspace-files`、`account-controller`)持有 Typert Remote 命名空间以及无 React 的 `/client` 对象层,同时新增十八个 `packages/client/*` 包。[alpha.2 审计](../../implemented/architecture/2026-09-20-upstream-alpha2-client-lane-audit.zh.md)裁决了 alpha 时代的文件残留,并拒绝了整体替换本地栈(`client/runtime` 对象层、`client/connection` + `host/apiproxy` 线缆、`ui-conversation`/`ui-workbench` 界面)的方案。rc1 把同一套对象层搬进了各控制器包的 `client/` 半边,并把 `ctx.remote` 重建在本地 Typert 不具备的 PeerScope 授权模型之上,因此采纳仍然要按行为逐项进行,每个新增包都需要对照一个具名的本地锚点记录裁决。

## Proposal

保留本地客户端栈;对每个 rc1 包给出裁决:**port**(与线缆无关且本地缺失的行为)、**adapt**(上游行为存在但依赖 Typert/api-controller 传输,采纳意味着在 `client/runtime`/`apiproxy` 上写适配层)、**skip**(与本地有意保留的界面重复,或依赖本地不存在的上游宿主能力)。

### 新增 `packages/client/*` 包

| 包 | 裁决 | 本地锚点 | 证据 |
|---|---|---|---|
| `store` | skip | `client/runtime/src/client/contract/store.ts` | 上游 `client/store/src/contract.ts` 导出的 `defineStore`/`createSnapshotStore`/`shallowEqual` zustand+immer 引擎与本地 runtime 所携带的相同;差异在包边界而非行为。 |
| `resources` | adapt | `client/runtime/src/client/workspace-resources.ts`;`ui-workbench/src/client/preview-readers.ts` | 上游 `client/resources/src/client/resources.ts` 把单一 provider 注册表推广到 `useResource` 之后,地址为 `dsh-resource://<type>/…`;本地 `WorkspaceResourceProvider`/`WorkspaceResourceSource` 是同一套 none/loading/live/failed 模型收窄到 `IApiClient` 上的 workspace 文件。 |
| `file-upload` | adapt | `interaction/commands` 的 `CommandSubmitAttachment`(线缆上已有 `{ type: 'file', receiptId }`);`userdoc-upload/src/index.ts`(断点续传先例) | 上游 `file-upload/src/index.ts` + `http-route.ts` + `client/runtime.ts`:agent 作用域的分阶段文件上传,经 `/api/session/uploadFileBinary` 铸造 `FileUploadReceiptId`,并有 `remote.fileUploads.upload` 兜底。本地 composer 经 `commands.execute` 内联发送图片;本地没有暂存服务。 |
| `shortcuts` | 已落地 | `packages/client/shortcuts` | 逐字移植:命令注册表、冲突校验、DOM 适配器、localStorage 持久化、固定输入通道,以及惰性守卫的 desktop preload 路径(`runtime === 'desktop'` 在 Web shell 上不会激活)。DOM 适配器依赖的 `modalSelector`/`observeComposition` 原语已并入 `ui-primitives`。 |
| `product-analytics` | skip | 无 | `client/product-analytics/src/index.ts` 经 `remote.productAnalytics` 上报,受 `dshDesktop` 与 `deepseekAccount` 门控;本地没有消费者、宿主服务或产品账号。 |
| `ui-approval` | skip | `ui-conversation/src/client/skeleton/ApprovalPanel.tsx`;`host/apiproxy/src/api/approvals.ts` | 上游 `ui-approval/src/client/index.ts` 走作用域 `approval/request` Remote waterfall;本地面板是 `PendingApproval` 载体(`ui-conversation/src/client/contract/slots.ts`)上的 composer 链条目。 |
| `ui-chat` | skip(包)、port 所列文件 | `ui-conversation/src/client/chat/*` + `conversation-nodes/*` | 上游 `ui-chat` 是同一批文件的搬迁:`chat/ChatView.tsx`、`conversation-nodes/*` 均与本地对应文件有 diff。 |
| `ui-plugin-manager` | adapt(里程碑) | `boot/plugin-manager`(`pluginManager`/`pluginInventory` Typert remote 已向 `ctx.remote` 暴露完整操作集);`ui-settings-plugins` + `ui-settings-plugin-inventory`;`apps/web/tests/plugin-administration.e2e.ts` | 上游把 3.6k 行的安装/启用/移除页挂在 `sidebar.panellist`——本地 sidebar 未声明的导航面板列表(`ui-sidebar` 只暴露 workspaces/settings 槽位)。本地 bundle 安装已走 Admin 工作流(`plugin-administration.e2e.ts`);inventory 与配置走 `settings.section`。移植该页意味着一个里程碑:在 `settings.section` 下重挂并移植 manager-store;remote 面已就绪。 |
| `ui-session` | skip | `ui-renderer/src/client/session-provider.tsx` | 两边都是 SessionProvider/会话作用域 provide 机制;按分叉,本地副本在 renderer 内。 |
| `ui-settings-account` | skip | 无 | `ui-settings-account/src/index.ts` 依赖 `dsh-deepseek-account` 配置 DeepSeek 登录、引导与计费,本地不存在该能力;`ui-usage-alert` 是另一个(Gateway 配额)界面。 |
| `ui-settings-agent-loop` | skip | `ui-settings-plugins/src/client/AgentLoopCard.tsx` + `agent-loop-card-controller.ts` | 卡片已在本地携带;上游只是改了打包方式,并经 `SettingsFormModel` 写 `agent-loop` 命名空间。 |
| `ui-settings-shell` | skip | `ui-settings-plugins/src/client/BashCard.tsx` + `bash-card-controller.ts` | 卡片已在本地携带。上游写 profile 条目命名空间 `bash-sandbox`/`pwsh-sandbox`(`shell-card-controller.ts`),本地卡片写 `shell`——未来同步前需要调和的宿主 settings schema 分叉。 |
| `ui-settings-subagent` | skip | `ui-settings-plugins` 的 `SubagentLimits*`/`SubagentModelSelection*` | 已在本地携带。上游命名空间 `subagent-model-selection-settings` 对本地 `subagent-model-selection`(`subagent-model-selection-card-controller.ts`)。 |
| `ui-settings-web-search` | skip | `ui-settings-plugins/src/client/WebSearchCard.tsx` + `web-search-card-controller.ts` | 已在 `web-search-deepseek` 上携带。 |
| `ui-settings-session-log` | adapt | 无;目标是 `session/session-log-deepseek` | 上游 `ui-settings-session-log` 经 `ctx.configForms` 切换 `session-log-deepseek.enabled`;本地该字段是普通非 volatile 的 `z.boolean().default(false)`(`session-log-deepseek/src/index.ts`),采纳需要 volatile 字段加一条 `SettingsScope` 写路径。 |
| `ui-shortcuts` | 已落地 | `packages/client/ui-shortcuts` | `Reference`/`Editor` 依赖本地 `shortcuts` 注册表渲染与录制绑定;该包已挂载进发布的 `web-app` patch。 |
| `ui-sidebar-documentpreview` | adapt | `ui-workbench/src/client/components/Workspace*Preview.tsx`、`pdf/`、`html/`、`excel/`、`office/FontNotice.tsx`;`host/apiproxy/src/workspace-files.ts`(`renderOffice`) | `excel/` 管线已落入 `ui-workbench`——见[工作台表格预览](../../implemented/feature/2026-10-01-workbench-spreadsheet-preview.zh.md):xlsx/xls/csv/tsv 在有界 worker 中解析并经 FortuneSheet 渲染,doc/docx/ppt/pptx 继续走 `readDocument`。仅上游剩余:`office/OfficeBody.tsx`(客户端 office 渲染)、`code/`、`image/`、`text/`、`zoom/`、`document/` 注册表与 tab 生命周期。 |
| `ui-sidebar-files` | adapt | `ui-workbench/src/client/components/WorkspaceFileBrowser.tsx`;`ui-sidebar-right` tab 注册表 | 上游 `ui-sidebar-files` 注册 `files` tab 类型,其树经 `workspaceFiles` Remote 懒加载目录并打开到 `dsh-resource` 查看器;本地文件浏览器是 `api.workspaceFiles.list` 上的 workbench 面板。 |

manifest 的 `exclusion-ledger` 决策对 `file-upload`、`ui-sidebar-files`、`store` 是已锁定的 owner 裁决:这些上游包不携带,`ui-commands` 的 `SubmitAttachment` 文件分支留在内联 receipt 路径上。`shortcuts` 则突破早前的台账行被携带——其 DOM/注册表/持久化半边完全兼容 Web(desktop preload 惰性守卫)——并解锁了 `ui-shortcuts` 以及 `ui-workspace`、`ui-sidebar-right`、`ui-conversation` 下的 `shortcuts.ts`/`stop-*` 面(`ui-conversation` 的双击 Escape 停止已落地)。`file-upload` 行的发现作为能力台账保留:本地没有分阶段上传服务,若要恢复它是新的 owner 决策,而非对齐项。

### 新增 `packages/api/*` 控制器

每个控制器的 `client/` 半边与 `client/runtime` 是同一套对象层谱系(`sessions/{manager,service,session,projection-store,notifier,remotes,assistant-stream,lineage}.ts` 原样出现在 `api/session-controller/src/client/` 下);每个宿主半边把一个 `apiproxy` 域改挂到 `ctx.remote.<ns>` 而非 `api.*` 一元端点上。因此下列包**作为包整体 skip**,除非所列操作在本地线缆上没有对应物:

| 包 | 裁决 | 本地锚点 | 证据 |
|---|---|---|---|
| `session-controller` | skip | `client/runtime/src/client/sessions/*`;`host/apiproxy/src/api/sessions.ts` | 两条线缆上操作集相同(`list`/`search`/`create`/`selectModel`/`rename`/`fork`/`prompt`/`attachment`/`updateQueue`/`cancel`);上游 `openWorkspacePath`/`workspacePathApplications` 对应本地 `host.openPath` 与 open-in-app 的 apps 路由;journal/snapshot 流对应 `sessions.history` 加 mux 帧。 |
| `workspace-controller` | skip | `client/runtime/src/client/workspaces/*`;`host/apiproxy/src/api/workspace*.ts` | `create`/`rename`/`delete`/`insertBefore`/`insertSessionBefore`/`archive`/`unarchive`/`pin`/`unpin`/`follow` 均以 `workspace.*` 端点存在。 |
| `settings-controller` | skip | `host/apiproxy/src/api/settings.ts` + `credentials.ts`;`ui-settings/src/client/settings-scope.ts` | `describe`/`update`/`replace`/`mutate`/`openSettingsDocument` 与 `credentials.{describe,set,unset}` 已走本地线缆;上游 `ConfigFormController` 与本地 `SettingsMutationScope` 是同一个 `SettingsDescribeMirror` 的孪生派生。 |
| `job-controller` | adapt | `host/apiproxy/src/api/jobs.ts`(`session/jobs` 帧);`ui-jobs/src/client/JobListAction.tsx` | 已按行为采纳而非移植流式协议:本地 `jobs.output`(非消费性 `readAt` 块、绝对游标、`lossy`/`next`)与 `jobs.kill`(`cancelled by the user` → `requested`/`already-finished`)走一元 RPC 面;`SessionManager.observeJob`/`killJob` 提供引用计数的观察服务与有界渲染尾部,`JobListAction` 渲染实时输出、留存的已终态输出与两段式 kill。上游的 `job.follow`/`observe.ts`/`wake.ts` 流与 `client/service.ts` 包拆分未移植([已落地记录](../../implemented/feature/2026-09-30-web-job-output-and-kill.zh.md))。 |
| `workspace-files` | skip | `host/apiproxy/src/api/workspace-files.ts` + `workspace-changes.ts`;`client/runtime/src/client/workspace-resources.ts` | `read`/`readBytes`/`stat`/`list`/`changes` 对应 `workspaceFiles.*`;`dsh-resource` provider 半边计入上面的 `resources`。 |
| `account-controller` | skip | 无 | `account.*` 包装 `dsh-deepseek-account`(登录、余额、奖励、过期监听);该宿主能力本地不存在。 |

### 共享包内未移植的上游行为

共享 `src/` 树的 `diff -qr` 输出由蓄意分叉主导(import 从 `dsh-api-*/client` 重接线到 `dsh-client-runtime`,slot 归属迁移);下表列出的是值得记录的残余行为,而非分叉本身。rc1 未改动的 alpha.2 裁决不再重复:`ui-plan` 评审界面、`ui-subagent` `sidebar-chat`、`ui-attachment` `FileCard`/`drop-events`、`ui-permission-presets` `PermissionSelect`、`ui-renderer` `bindings`/`registry`、`ui-model-selection` `catalog.ts`、`ui-goal` `activation-source.ts`、`ui-theme` `FontSizeRow`、`ui-trajectory` `string-wrapping-store`/`trajectory-event-projection`、`ui-sidebar` `HeaderLeadingControls`、`ui-primitives` `Checkbox`/`SiteGlyph`/`darwin-desktop`/`FoldToggle`/`file-size`/`rank-by-name`。

| 包 | 仅上游存在的行为 | 处置 |
|---|---|---|
| `connection` | `browser-auth.ts`(请求信任围栏旁的 HMAC cookie 会话签发)、`operator-peer.ts`(`PeerScope`/`invocation.peer`)、`recovery-config.ts`、`rpc-schema.ts` | `browser-auth` 已落地——见[浏览器会话认证](../../implemented/architecture/2026-10-01-browser-auth-web-transport.zh.md):启动令牌交换铸出按 authority 域名的 HMAC cookie,`authority: 'loopback'` 子树为机器调用方保留仅围栏准入,`apply` 变为异步使 Web 路由挂在 `ctx.inject(['webServer'], …)` 之下。`operator-peer`/`rpc-schema` 属于上游传输层。 |
| `ui-commands` | `SessionReferenceSourceMap.commandCatalog` 保留与目录 RPC 前的初始历史等待已落地(经本地 `sessions.using`/`binding` 接缝);`rankByName` 的算法已在本地以 `fuzzyCandidates`/`fuzzyScore` 实现(同一子序列 DP 与 prefix/score/源序排序键)——差异仅是上游把它打包进 `ui-primitives`;`SubmitAttachment` 的 file 分支等 `file-upload` | 已覆盖;仅当出现第二个消费者时才把排名器提升进共享包。 |
| `ui-schedule` | `TaskManagerPage`、创建卡片、日期/时钟选择器、`SessionScheduleMark`、投递历史、经 `remote.schedule.*` 的删除/更新 | 已在宿主持有的任务存储上落地:`schedule/schedule` 把任务保存在 `storage.ts`/`delivery-history.ts`/`update.ts` 并发布 `schedule/changed`;[会话式投递决策](../../archived/simplification/2026-08-09-conversational-schedule-delivery.md)已被取代并归档。该包常驻已发布的 `web-app` patch,但要等 `experimental/schedule-bundle` 启用后才激活。浏览器投影运行于 `ClientSessionKey`:目录行经 `ctx.sessions.keyFor` 规范化,Remote 调用再解码回裸 Host id——见[计划目录会话标识](../../implemented/bug-fix/2026-10-03-schedule-catalog-session-identity.zh.md)。 |
| `ui-jobs` | 逐行 observe/kill 注入面 | 由 `job-controller` 裁决覆盖。 |
| `ui-workspace` | `session-actions/`(fork/rename/archive/pin 行操作)、`navigation.ts`、`pin-order.ts`、`shortcuts.ts`、`rows/AnimatedRows` | `AnimatedRows` 已落地(对分组树与扁平列表做 FLIP 移动/进出场渐变,受 ready/拖拽/reduced-motion 门控)。`shortcuts.ts` 已落地:六条可编辑命令(新建/搜索/添加/重命名/分叉/归档)发布进浏览器自有的请求仓库,搜索框、添加选择器、会话重命名对话框与分叉失败提示消费它,行/头部按钮显示当前键位。行操作与本地 `WorkspaceBrowser` 菜单重复。`pin-order.ts` 已落地:`pinnedSessionIds` 进入 workspace 行状态,置顶行在各分区内领先并保持区内次序且只能彼此重排,`pinSession`/`unpinSession` 走既有 Host RPC 后经 `pinOrderSource` 调和分组/扁平账户次序。 |
| `ui-open-in-app` | `FileRouteAction`、`OpenPathAction`、`OpenPathEmptyAction`、`OpenTargetButton`、`file-applications.ts`、`open-path.ts` | 行为落在 `ui-deliverables` 内:`host.openPath` 增加 `action`/`application`,`host.fileApplications` 列出已注册处理器(PNG/SVG data-URL 图标),`host.describe` 上报 `fileManager`,`PresentedFileCard` 每次打开菜单重新查询且 Host 复核所选 id。`FileRouteAction`/`OpenPathEmptyAction` 的挂载点等待 `ui-sidebar-documentpreview`(尚未落地)。 |
| `ui-deliverables` | `FileDiff.tsx`、`file-actions.ts`、`present-open.ts`(`ctx.connection.fetch` 路由) | `FileDiff` 落地为共享对比渲染器(单栏/双栏/换行、经 `useCodeHighlighter` 的语法高亮、created/deleted/unchanged/binary/oversized/truncated 各态):`ReviewTab` 消费它,`ChangedFiles` 通过 `preview` 变体的 `HoverCard` 获得 500ms 悬停预览(上游 `Tooltip`/`HoverCard`/`input-modality`/`overlay-top-margin`/`focus.css` 随之移植)。`deliverables.file.actions`/`deliverables.review.file.actions` 保持不声明:上游槽位供 `ui-open-in-app` 贡献动作,本地未携带该包——`PresentedFileCard` 已拥有等价内联菜单。 |
| `ui-sidebar-right` | `session-view.ts`/`session-views.ts`(`SessionReferenceSourceMap.sidebarView` 保留)、`focus.ts`、`shell/close-focus.ts`、`shortcuts.ts` | 已在本地 session-store 采用模型上落地:`SidebarSessionViews` 经 runtime `sessions` 引用选择/保留视图,`sidebarTargetFromElement`/`visibleSidebarPane` 捕获 docked/floating 页面焦点,`page.close` 的 modal-dismiss 由 `closeTopModal` 承担,`registerSidebarShortcuts` 把 `sidebar.right.toggle`/`pane.split`/`pane.fullscreen.toggle`/`page.close`/`page.refresh` 绑定到 `commandTarget`/`focusedTarget`/`isTargetCurrent`。与 `ui-layout` 的 `sidebar.left.toggle` 撞绑键已按上游修正(left:桌面 `primary`/web `primary+alt`;right 保持 `primary+alt`/`primary+shift`)。 |
| `ui-chat`(`ui-conversation` 中不存在的文件) | 节点 `process-activity.ts`、`process-groups.ts`、`turn-navigation.ts`、`turn-process-presentation.ts`、`partial.ts`、`request-prompt.ts`、`event-projection.ts`;视图 `ChatGroupSeat`、`TurnTriggerNodeView`、`RunningStatus`/`RunningWhaleTail`、`QuotaNoticeHost`、`ApprovalCommand`;设置行 `TranscriptViewRow`/`LinkOpeningRow`/`PerformanceUsageRow` 与 `chat-settings.ts` 的 `transcriptView` 偏好 | 未移植的会话行为,逐件并入 `ui-conversation`,绝不整包并入。 |
| `ui-conversation` | 上游 `contract/*` 拆分、`skeleton/Conversation{Content,Header,MainPanel,Panel,WidthControls}`、`input/editor`、`view-selection.ts`、`context-occupancy.ts`、`submission-analytics.ts`、`stop-sequence.ts`/`stop-shortcut.ts` | `stop-sequence.ts`/`stop-shortcut.ts` 已落地(双击 Escape 取消,按会话、turn、binding 代际与 DOM 区域限定;tooltip 展示 `Esc Esc`)。`ConversationSnapshot.openTurn` 取代上游的 open-turn 解析器。`submission-analytics` 等 `product-analytics`;其余是分叉。 |
| `ui-tool` | `PreparingToolRow`、`ToolDetails`、`details-row`、`control-details-model`、`detail-model-shared`、`details-card-model`、`inspection-details-model`、`todo-diff-model`、`todo-history`、`tool-call-arguments-partial` | 已落地:详情/diff 模型组加上 `PreparingToolRow` 与部分参数渲染支撑详情面板。`extensions/ui-cordis`、`ui-skill`、`ui-deliverables` 现在经 `CordisPreparingRow`/`PreparingPresentRow`/`SkillRow` 分支 `phase: 'preparing'`(keyed `toolview` 卡片在参数流式期间不再读取已派发参数);cordis 行失败时保留工具字形而不再替换为 `StateDot`。 |
| `ui-primitives` | `settings-form/`(`SettingsFormModel`)、`SegmentedControl`、`MenuSurface`、`ImageLightbox`/`ImagePreview`、`PathLabel`、`PermissionIcon`、`TextShimmer`、`CodeCard`/`CodeToolbar`/`code-highlighting`、`focus.ts`、`guide-artwork`/`shared-artwork`/`plugin-artwork`、`input-modality`、`markdown/local-image-syntax`、`overlay-top-margin`、`useModalLayer` | `SegmentedTabs`、`keyboard-composition`/`observeComposition`、`modalSelector`、`ShortcutKeys`(连同 `Tooltip.shortcutKeys` 与 tooltip 按键主题别名)、`focus.ts`/`focusWithoutRing`、`rank-by-name.ts`/`rankByName` 与 `useModalLayer`/`closeTopModal`/`isBehindModal` 已随 preset-guide、shortcuts 与快捷键查阅消费者落地;本地 `Modal` 与 Settings 面板现运行在 `useModalLayer` 上(栈式 Escape/Tab 归属、`data-shortcut-modal` 作用域、无圈自动焦点),`ui-commands` 消费共享排名器。`TextShimmer` 连同 `DisclosureRow` 的 `running`/`contentClassName`/`contentLayoutClassName` 属性已随 preparing-row 消费者落地;仅当有卡片离开 `CardForm` 时才需要 `settings-form`。 |
| `ui-settings` | `config-form.ts`/`config-form-types.ts`(`ctx.configForms`)、`developer-tools.ts` + `developer-tools-settings.ts` | `config-form` 与 `SettingsScope` 重复(skip)。`developer-tools` 推迟:其唯一消费者是上游 `ui-chat` 诊断视图与 `ui-sidebar-documentpreview` 脚本化 HTML 预览,二者均未移植,落地即成死状态;随首个消费者一并落地。 |
| `ui-settings-general` | `DeveloperToolsRow`、`CurrentVersionRow`、`DesktopUpdateIndicator`/`desktop-update-source`;`shell-store.ts` + `settings.open` 已落地 | shell 现拥有声明式 `SettingsShellStore`(`open`/`activeId`/`navigationScope`)并注册 `settings.open`(`Mod+,`;被其他模态阻塞,Settings 为顶层时经 `closeTopModal` 关合)。`DeveloperToolsRow` 随 `ui-settings` 偏好一并推迟;版本/更新器界面仅 Electron 可用。 |
| `ui-settings-models` | `WelcomeNotice`/`welcome-store`/`operations`/`onboarding-*`、`ModelRow`/`ModelInputTypes`/`protocol-label` | alpha.2 裁决维持:本地没有首跑目录引导。 |
| `ui-agent-preset` | `PresetGuideDialog` + `guide-locales.ts` 已随附:随附 preset 卡片上的「模式说明」/「如何使用」只读阅读器,底层是移植进 `ui-primitives` 的 `SegmentedTabs` 原语 | 已对照本地卡片区落地;`SegmentedControl` 未引入——`SegmentedTabs` 已覆盖页签条。该对话框现运行在本地 `Modal` 为快捷键查阅链路采纳的共享 `useModalLayer` 栈上。 |
| `ui-sidebar-browser` | `BrowserPage`/`IframeImpl`/`BrowserPresentation`/`IframePresentation`、`electron/`、`pages.ts` | 页面工厂拆分加 Electron `webview` 页;本地 `BrowserFrame` 模型是有意保留的更简单界面。 |
| `ui-dockkit` | `TabLayout.tsx` | 本地 shell 未组合的可停靠 tab 网格渲染器。 |
| `ui-theme` | Montserrat 品牌字体、`onboarding.css`、`focus.css` | 上游账号引导的样式;随 `ui-settings-account` 一并 skip。 |
| `web` / `locale` | `window-drag`、`client/bootstrap.ts`(`__DSH_LOCALE__`) | 仅 Electron/原生 shell——rc1 确认:本地只发 `apps/{web,cli,android-shell}`,无 Electron shell,macOS 拖拽区回收机制没有消费者。 |
| `ui-message-feedback` | `surface.ts`(`FeedbackSurface` 配对) | 组织性拆分;本地反馈控制器配对已在包内文件。 |

## Alternatives considered

**整体采纳 rc1 控制器栈。** 否决理由与 alpha.2 相同且更强:控制器 `client/` 半边是针对 `ctx.remote.<ns>` Typert 命名空间加 gateway `RemoteJournalStream`/`RemoteSnapshotStream` 载体与 `PeerScope`/`invocation.peer` 授权模型(`packages/typert/protocol`、`connection/src/operator-peer.ts`)生成的,这些在本地线缆上都不存在;采纳它们会丢弃分叉有意保留的 Workbench 与 `host/apiproxy` 所有权。

**只采纳控制器的 `client/` 半边。** 否决:`api/session-controller/src/client/sessions/remotes.ts` 显示该对象层是 Remote 命名空间的传输投影——没有这些命名空间,半边就是死代码,而 `client/runtime` 已携带同一谱系加本地扩展(`conversation-*`、`queue-mirror`、`pending`、`pool`、`steering-history`、`subagent-lineage`、`tool-call-tree`)。

**因为卡片已存在就整体跳过 `ui-settings-*`。** 按字面否决但收窄:包跳过,而*命名空间漂移*(`bash-sandbox`/`pwsh-sandbox`、`subagent-model-selection-settings`)被记录为未来同步的 schema 隐患,而非忽略。

## Acceptance criteria

- 六个 rc1 api 控制器与十八个新客户端包全部在本note中携带裁决、本地锚点与证据路径。
- 共享客户端包中每个 `Only in upstream` 的 `src/` 条目,要么从 alpha.2 台账再次确认,要么在未移植表中点名。
- 每个被采纳的特性各自携带 Agent Note 与消费者落地;没有排期的未移植条目留在本表中。

## Risks

- 表记录的是处置而非特性等价;skip 包内的仅上游文件(如 `ui-chat` 的 conversation 节点)在各自移植落地前仍是未裁决行为。
- 上游 profile 条目 settings id 与本地能力命名空间之间的漂移,意味着原样复制上游卡片或表单会写错命名空间;每个 settings 移植都必须先在本地宿主上解析命名空间。
- `PeerScope` 的缺失意味着任何未来的控制器采纳都以一次 Typert 升级为前置,因此这些 skip 裁决是结构性的而非编辑性的。
- `ui-sidebar-documentpreview` 把预览所有权拆到了客户端解析(上游)与宿主 `renderOffice`(本地)两侧;逐件采纳可能让同一文档类型留下两条渲染路径。

## Verification

- 对每个共享包执行 `diff -qr $UPSTREAM/packages/client/<pkg>/src packages/client/<pkg>/src` 可复现仅上游列表(上游根:`dsh-v0.2.0-rc1` worktree)。
- `diff -qr $UPSTREAM/packages/api/<controller>/src/client packages/client/runtime/src/client` 可复现 `session-controller` 的对象层重叠。
- `grep -rn "@Remote" $UPSTREAM/packages/api/<controller>/src` 对 `grep -n "RpcResponse" packages/host/apiproxy/src/api/<domain>.ts` 可复现端点等价结论。
- `grep -rn "PeerScope\|PeerId" packages/typert packages/api`(为空)对照上游树,确认授权模型缺口。
- `grep -rn "remote.pluginManager" packages/client`(为空)确认 `ui-plugin-manager` 缺少本地消费者。
