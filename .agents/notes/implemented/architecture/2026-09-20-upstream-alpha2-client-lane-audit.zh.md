# Agent Note：7A 车道 client 包对上游 alpha.2 的审计

Status: implemented

[English](2026-09-20-upstream-alpha2-client-lane-audit.md) | 中文

## 问题

`dsh-v0.1.5-alpha.1 → dsh-v0.1.6-alpha.2` 残留报告列出 20 个 stale 文件（本地仍停留在 alpha.1 内容而上游已改动）与 78 个 unadopted 文件（上游新增、本地缺失），分布在 `adapted`/`replaced` 的 client 包中。每个文件都需要记录在案的裁定——移植、已覆盖、或有意不带——使残留清单不含未解释条目。

## 决策

**已移植**（存在真实本地消费方时采纳其行为）：

- `client/ui-message-feedback` —— 已采用 Session 反馈弹窗与命令动作行为；现有消息反馈 sidecar 保持独立。[反馈决策](../feature/2026-07-28-feedback-command.zh.md)负责说明两者区别。
- `client/modules`、`client/hmr` 与 `client/web` —— 启动批次和页面级 Loader 条目遵循[共享条目生命周期决策](2026-09-23-page-owned-client-entries.zh.md)。Cordis 之前的 bootstrap 与之后的 Loader 归属兼容；此前的省略理由不成立。
- `ui-tool` + `runtime`——Auto-review 拒绝呈现（见姊妹 note `2026-09-20-auto-review-denial-presentation`）。
- `ui-tool` 终端卡片——落定侧的 spill 通知与 persistent shell 守卫，以及它们消费的浏览器安全入口 `@deepseek-ai/dsh-spill-policy/notice`。决策细节见 [Web 终端卡片](../feature/2026-07-28-web-terminal-card.zh.md) note。
- `ui-tool` + `fs/tool-fs` `read_image` 画廊——`image-card-model.ts`、共享 `read-family-row.tsx` 组装、keyed `read-image-row.tsx` 与持久化 `presentationMeta` 路径投影已承接；`readCallLine` 把调用自己的 1 基偏移传入 `openFile`。上游的 `tool.call.images` 子槽未移植：本地 chat 节点已通过 `renderMessageImages` owner prop 把渲染器递给行（背后是 `conversation.message.images`），details 面板则通过自己的 `conversation.details.images` 姐妹槽位到达同一附件画廊——槽名全局唯一，第二个父级不能重复声明 chat 槽名。
- `host/directory-picker-native`——Win32 Alt 按键前台授权（见 `2026-09-20-win32-directory-dialog-foreground`）。
- `extensions/tool-cordis`——采用 `inspect.ts` 的运行时检视精简；`fiber-state.ts` 已删除。模型执行注册遵循上游退役，本地只读 `cordis_inspect_self` 与显式引用仍保留。[退役决策](../simplification/2026-09-22-retire-dynamic-cordis-model-tools.zh.md)替代此前保留执行工具的选择。
- `subagent/subagent`——`SubagentCatalogEntry` 的 client 再导出（上游现已一致）。
- `client/ui-settings-general` locales——`connection.*` 文案，减去本地 Web 壳从不渲染的 desktop-update 键；`connection.retry` 保留，因本地消费方仍在使用。
- `client/ui-user-questions`——模块注释改写；内容已与上游一致。

**未携带路径与本地消费者。** `removedUpstreamPaths` 记录文件处分，不表示对应行为已完成。已批准行为仍需可达的本地消费者和验收证据：

- `client/ui-attachment`（3 个文件）——`drop-events.ts` 内联进了本地 `ComposerAttachments` 的监听；`FileCard*` 不移植，因为本地作曲区经 `InputBar` 的 `DocumentRail` 行呈现待上传文档。
- `client/ui-renderer`（3 个文件）——`SlotAssemblyError` 本地住在 `session-provider.tsx`；`bindings.tsx`/`registry.ts` 是上游渲染机件的拆分，本地 renderer 不共享该拆分。
- `client/ui-conversation`（38 个文件）——上游的 `DraftEditor`/`editor/*`、`ConversationContent`/`MainPanel`/`Panel`/`WidthControls`/`DefaultConversationViews` 骨架、`contract/*` 与 `conversation/*` 组装机件、`context-occupancy`/`view-selection` 与 `historical-images`；本地 input 是 `blocks`/`machine`/`facade` 架构，骨架是 Workbench 的 `ConversationRoot`/`Session`/`DetailsPanel` 设计，历史图片经 `MessageImages` + `loadImage` 加载。
- `client/ui-deliverables`——轮次尾部交付物及不可变文件变更 Review 使用[授权工作区审阅](2026-09-23-authorized-workspace-review.zh.md)和共享侧栏。缺少上游同名文件不表示产品决定仍被延期。
- `client/ui-permission-presets`（`PermissionSelect`/`catalog.ts`）——作曲区权限选择器本地住在 `ui-conversation` 骨架中。
- `client/ui-plan`（9 个文件）——上游 PlanCard/PlanPreview/review-store 界面；本地计划评审是 `ui-user-questions` 的 `PlanReviewPanel` 作曲接管，由 `plan-review` 问题意图驱动。
- `client/ui-primitives`（7 个文件）—— `darwin-desktop` 没有 Electron 消费方；`Checkbox` 与 `SiteGlyph` 尚未移植。`MarkdownDelegate` 与 `file-link` 已通过[账户隔离的辅助侧栏](2026-09-23-account-scoped-auxiliary-sidebar.zh.md)承接。`rank-by-name.ts`——上游共享的模糊 `/` 菜单排序（有序子序列打分、前缀优先，由 `ui-commands` 与 `ui-skill` 消费）不同于本地 `ui-commands` 的 `filterOptions`：后者按 label 与 detail 的大小写不敏感子串过滤行并保持源序。本地机制是有意的简化；模糊排序仍是待移植项，需适配 `SelectOption` 的 label/detail 模型。`FoldToggle.tsx`/`file-size.ts` 仅服务未携带的上游界面（FileCard 轨与折叠转写视图）。
- `client/ui-settings-general`（4 个文件）——桌面更新指示器及其 bridge/source 仅属 Electron。
- `client/ui-settings-models`（7 个文件）——`ModelRow`/`ModelInputTypes` 是上游目录编辑器的共享字段行，`WelcomeNotice`/`welcome-store`/`operations`/`onboarding-copy` 驱动上游首跑目录引导；本地编辑器保留各自内联字段且无首跑模型引导。
- `client/ui-settings-plugins`——[Subagent 限制](2026-09-23-scoped-subagent-limits.zh.md)与上游字段帮助已适配到键控 `settings.plugin.item` 卡片。模型选择控件复用同一命名空间卡片所有者及 Host 原子写入；Admin 配置集成仍需本地消费者；设置外壳不同不免除这些要求。
- `client/ui-sidebar`（`HeaderLeadingControls`）——依赖 `isDarwinDesktop` 的 macOS 桌面侧栏控件。
- `client/ui-subagent`（`sidebar-chat/`、`subagent-lineage.ts`）——基于未携带的 `ui-sidebar-right`/`client-resources` 的右侧栏会话视图；本地 subagent 经 `SubagentHeaderLineage`/`SubagentReadOnlyComposer` 在会话内呈现，谱系推导由本地自有实现承担。
- `client/ui-theme`（`FontSizeRow*`）——上游的内容字号偏好设置行；本地主题设置仅暴露 `AppearanceRow`，不携带字号设置。
- `client/ui-trajectory`（`code-program.ts`、`string-wrapping-store.ts`、`trajectory-event-projection.ts`）——结构化 `run_code` 检视页、供其使用的事件投影与持久化 JSON 字符串换行偏好服务于上游轨迹视图；本地轨迹展示子派发单元与原始 payload。结构化代码检视器仍属延期移植，需本地视图适配。
- `client/ui-workspace`（4 个文件）——`rows/WorkspaceBrowser*`、`navigation.ts` 与 `subagent-lineage.ts` 是上游的浏览行布局；本地 `WorkspaceBrowser` 直接位于 `src/client/` 下，导航与谱系代码自有。
- `client/ui-goal`、`client/ui-layout`、`client/ui-model-selection`、`client/ui-settings`、`host/directory-picker`、`sdk/client`、`session-query/session-log-export`、`context/session-reference`、`fs/tool-fs-search`——各一文件：上游界面由本地架构在别处覆盖（activation-source、DocumentTitle、模型目录、settings-contract、picker 类型、SDK 启动助手、日志归档写出器、session-reference spill、`ripgrep.d.ts` ambient 类型）或按设计不携带。
- `test-support/client-runtime`（`assembly/`）——本地包测试直接组合插件，真实组装浏览器测试覆盖已采用的页面自有 Loader 条目。Cordis 前引导不能成为省略 Loader 生命周期验证的理由。

**保留的本地组装：**

- `client/ui-settings-plugins`——`AgentLoopCard`、`BashCard`、`ConfigurablePluginsTab`、`PluginsSettingsSection`、`slot-contract.ts`：本地键控卡片拥有设置分区。每项上游交互和配置行为仍需承接或明确的产品决定。
- `client/ui-sidebar` `locales.ts`——上游 `panels.label` 喂给本地 `SidebarRoot` 不渲染的全局面板 `<nav>`。

## 备选方案

**整体替换本地包。** 否决：这会丢弃 Workbench 与 Gateway 的所有权。已采用行为通过薄适配层接入这些所有者；缺少消费者仍属于未完成工作。

**在本地设置卡片旁并存上游 `ui-plugin-manager`。** 否决：两套插件设置界面会争夺同一 section 槽位，并在每次后续同步中继续分叉。

## 影响

文件台账不证明功能等价。结构化轨迹检查和完整 Admin 配置仍是实施义务。交付物 Review 与会话反馈已有本地消费者及各自证据；最终候选验收仍须单独完成。

## 测试

`pnpm exec tsx scripts/sync-upstream-report.ts -- --tag dsh-v0.1.6-alpha.2 --residue dsh-v0.1.5-alpha.1` 可复现被审计清单；`pnpm exec tsx scripts/verify-upstream-sovereignty.ts` 校验每条 `removedUpstreamPaths` 在同步 tag 存在且磁盘缺席。移植切片自带通过中的测试（见姊妹 note）。
