# Agent Note：7A 车道 client 包对上游 alpha.2 的审计

Status: implemented

[English](2026-09-20-upstream-alpha2-client-lane-audit.md) | 中文

## 问题

`dsh-v0.1.5-alpha.1 → dsh-v0.1.6-alpha.2` 残留报告列出 20 个 stale 文件（本地仍停留在 alpha.1 内容而上游已改动）与 78 个 unadopted 文件（上游新增、本地缺失），分布在 `adapted`/`replaced` 的 client 包中。每个文件都需要记录在案的裁定——移植、已覆盖、或有意不带——使残留清单不含未解释条目。

## 决策

**已移植**（存在真实本地消费方时采纳其行为）：

- `ui-tool` + `runtime`——Auto-review 拒绝呈现（见姊妹 note `2026-09-20-auto-review-denial-presentation`）。
- `host/directory-picker-native`——Win32 Alt 按键前台授权（见 `2026-09-20-win32-directory-dialog-foreground`）。
- `extensions/tool-cordis`——`inspect.ts` 的运行时检视精简；`fiber-state.ts` 已删除。`present.ts`/`prompt.ts` 有意停留在 alpha.1：上游把 `cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine` 的注册迁入了 `cordis-host-runner`，而本地接缝把全部 `cordis_*` 模型工具保留在 `tool-cordis`，runner 仅提供服务。
- `subagent/subagent`——`SubagentCatalogEntry` 的 client 再导出（上游现已一致）。
- `client/ui-settings-general` locales——`connection.*` 文案，减去本地 Web 壳从不渲染的 desktop-update 键；`connection.retry` 保留，因本地消费方仍在使用。
- `client/ui-user-questions`——模块注释改写；内容已与上游一致。

**记为有意缺席**（`removedUpstreamPaths` 条目；每个所列路径在同步 tag 存在且本地磁盘缺失）：

- `client/modules` `entries.ts`/`entry-lifecycle.ts`——上游在 cordis 内对账页面持有的 Loader `Entry`；本地模块系统由壳内核在 cordis 存在之前构建（引导例外），这些辅助没有消费方。
- `client/web` `apply-injections.ts`——只服务于上游桌面壳引导（`__dshDesktopBoot`），本地 web 入口从不运行它。
- `client/ui-attachment` `drop-events.ts`——本地 `ComposerAttachments` 内联安装文档级拖放监听。
- `client/ui-renderer` `errors.ts`——`SlotAssemblyError` 本地住在 `session-provider.tsx`。
- `client/ui-conversation`（11 个文件）——上游的 `DraftEditor`/`editor/*` 与 `ConversationContent`/`MainPanel`/`Panel`/`WidthControls`/`DefaultConversationViews` 骨架；本地 input 是 `blocks`/`machine`/`facade` 架构，骨架是 Workbench 的 `ConversationRoot`/`Session`/`DetailsPanel` 设计。
- `client/ui-deliverables`（19 个文件）——上游的变更文件 Review 页与呈现文件预览建立在分叉未携带的 `ui-chat` 契约上；本地 `ProducedFiles` 收尾行覆盖了已发布的子集。差异评审界面仍是延期产品决策。
- `client/ui-message-feedback`（`FeedbackDialog`/`dialog.ts`/`surface.ts`）——上游的会话级 `/feedback` 对话框；本地有意只发布逐消息气泡备注设计。
- `client/ui-permission-presets`（`PermissionSelect`/`catalog.ts`）——作曲区权限选择器本地住在 `ui-conversation` 骨架中。
- `client/ui-plan`（9 个文件）——上游 PlanCard/PlanPreview/review-store 界面；本地计划评审是 `ui-user-questions` 的 `PlanReviewPanel` 作曲接管，由 `plan-review` 问题意图驱动。
- `client/ui-primitives`（6 个文件）——`darwin-desktop` 是无 Web 消费方的 Electron 壳检测；`Checkbox` 在上游只服务于未携带的 `ModelInputTypes`；`SiteGlyph`、`MarkdownDelegate`、`file-link` 只服务于未携带的 `ui-chat`。
- `client/ui-settings-general`（4 个文件）——桌面更新指示器及其 bridge/source 仅属 Electron。
- `client/ui-settings-models`（`ModelRow`/`ModelInputTypes`）——上游目录编辑器的共享字段行；本地编辑器保留各自内联字段。
- `client/ui-settings-plugins`（10 个文件）——`PluginConfigForm` 与 Subagent 字段/控制器家族属于上游 `ui-plugin-manager` 页，本地以键控 `settings.plugin.item` 卡片取而代之。
- `client/ui-sidebar`（`HeaderLeadingControls`）——依赖 `isDarwinDesktop` 的 macOS 桌面侧栏控件。
- `client/ui-subagent`（`sidebar-chat/`）——基于未携带的 `ui-sidebar-right`/`client-resources` 的右侧栏会话视图；本地 subagent 经 `SubagentHeaderLineage`/`SubagentReadOnlyComposer` 在会话内呈现。
- `client/ui-trajectory`（`code-program.ts`、`string-wrapping-store.ts`）——结构化 `run_code` 检视页与持久化 JSON 字符串换行偏好服务于上游轨迹视图；本地轨迹展示子派发单元与原始 payload。结构化代码检视器仍属延期移植，需本地视图适配。
- `test-support/client-runtime`（`assembly/`）——引导上游 `bootClient`/`Entry` 加载路径；本地 cordis 前引导使该路径按设计不可测，本地测试直接组合插件。

**有意保持 stale**（保留 alpha.1 内容；上游改动无本地对应物）：

- `client/ui-settings-plugins`——`AgentLoopCard`、`BashCard`、`ConfigurablePluginsTab`、`fields.tsx`、`PluginsSettingsSection`、`slot-contract.ts`：alpha.2 的修改服务于 plugin-manager 表单；本地键控项卡片是发布设计。
- `client/ui-sidebar` `locales.ts`——上游 `panels.label` 喂给本地 `SidebarRoot` 不渲染的全局面板 `<nav>`。
- `client/web` `index.ts`——上游唯一改动是导出未携带的 `apply-injections.ts`。

## 备选方案

**按包整体移植上游文件。** 否决：多数未携带文件实现的是桌面壳或上游独有契约、本地无消费方，违反"要求当前拥有者与需求"原则；已移植集合恰是有真实本地消费方的子集。

**在本地设置卡片旁并存上游 `ui-plugin-manager`。** 否决：两套插件设置界面会争夺同一 section 槽位，并在每次后续同步中继续分叉。

## 影响

残留报告的剩余条目全部有了解释：或为 `removedUpstreamPaths` 台账行，或为有据的 stale 文件。延期移植（deliverables 差异评审、轨迹代码检视器、会话级反馈对话框）在此保持可见而非伪装成已完成；采纳其中任何一项都需要上述本地消费面先行就位。

## 测试

`pnpm exec tsx scripts/sync-upstream-report.ts -- --tag dsh-v0.1.6-alpha.2 --residue dsh-v0.1.5-alpha.1` 可复现被审计清单；`pnpm exec tsx scripts/verify-upstream-sovereignty.ts` 校验每条 `removedUpstreamPaths` 在同步 tag 存在且磁盘缺席。移植切片自带通过中的测试（见姊妹 note）。
