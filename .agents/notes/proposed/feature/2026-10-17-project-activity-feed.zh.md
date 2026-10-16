# Agent Note: 项目动态记录——面向人的成员输入视图

Status: proposed

[English](2026-10-17-project-activity-feed.md) | 中文

## 问题

共享项目 runtime 承载多个成员的多个会话。现在回到项目的成员只能通过翻完整对话、或直接问 agent，才知道队友做了什么。用户输入早已带参与者署名落库，但缺少一个能回答「谁说了什么、选了什么」的面向人的视图。本笔记把这个视图设计为右侧栏面板，不引入面向模型的记忆。

## 决定

新增**项目动态记录**：`ui-project-activity` 客户端插件，按三种维度（时间 / 会话 / 成员）分组展示当前项目的成员消息与提问回答，并支持跳转到对应消息。

### 记录内容

- **消息**：`source.kind === 'user'` 且 `source.participant` 带署名的 `user/message` 事件。与 `conversation_search` 的人类输入口径一致；目标总结、署名提示、定时任务 / webhook 等其他 `source.kind` 的注入文本不出现。
- **提问回答**：`conversation_interaction_responses` 中 `interaction_kind='question'` 的行——回答者与所选答案已在 `responder_user_id` 与 `outcome` 中持久化。回答行通过工具的 `callId` 关联回提问。

审批、权限模式切换、自动化运行、未读标记、通知均不在范围。私有会话永不出现；面板沿用 `listConversations` 的可见性 SQL。

### 派生方式：查询时计算，不建派生表

每个字段都已在持久化存储中，feed 是一次分页读，不是新的写路径：

- 消息来自 `conversation_events`（`event_type='user/message'`），该表存有含 `source.participant` 的完整事件 JSON。
- 回答将 `conversation_interaction_responses` 按 `call_id` → `event->'data'->>'callId'` 连接 `conversation_events`，已有部分索引覆盖。提问原文来自对应 `tool/call` 事件的 arguments；seq 锚点来自 `tool/result` 行。

唯一的持久化缺口是认领行上的 `callId`：`question/requested` 在传输中携带 `wait.callId`，但不是已记录的会话事件，认领时 rpcId↔callId 的关联丢失。迁移 056 给 `conversation_interaction_responses` 增加 `call_id text NULL`；`execution.answer` / `claimInteraction` 增加可选 `callId`，由 api-proxy 从 `pending.wait.callId` 填入。迁移之前的认领 `call_id` 为 NULL，显示为「问题无法定位」——回答者与答案照常显示，但没有跳转和提问原文。

### 服务端

Gateway 新增 `GET /account/api/projects/:projectId/activity?cursor=<keyset>&limit=<n>`，与 `/account/api/conversations` 并列。处理器校验项目成员身份，对所属根会话应用 `listConversations` 的可见性条件，返回规范化的 `ProjectActivityItem` 列表。浏览器与其他协作读操作一样携带会话 cookie 调用。

### 客户端

- `packages/client/ui-project-activity` 注册 `sidebarRightTabs` 标签类型以及 `sidebar.right.pane.tab`、`sidebar.right.pane.tab.title` 插槽，与 `ui-sidebar-terminal` 同形。该客户端行在 web-app 组合中以 `disabled: true` 装载，再由 `PROJECT_RUNTIME_PATCH` 启用——个人空间默认无此标签，项目空间默认出现。
- 面板通过包内私有 `fetch` 客户端（`credentials: 'same-origin'`）拉取，参照 `conversationProject` 从协作上下文解析 projectId。
- 跳转分两级：点会话名聚焦或打开窗格（`conversationViewport.replaceActive`）；点条目调用新增的 `ConversationViewport.reveal(sessionId, seq)`——viewport 聚焦窗格并发布 reveal 请求；所属 `ChatView` 订阅后定位包含该 `seq` 的 turn，经既有 `loadHistoryUntil` 加载历史并滚动到对应行。这是本次唯一新增的跨插件能力。

### 呈现（已评审 HTML 稿）

L1 细线列表：日 → 会话 → 条目，行间 0.5px `border-l1` 分隔；工具条内 segmented「时间 | 会话 | 成员」分组切换、成员筛选、手动刷新。回答渲染为灰色提问原文 + accent tint `radius-full` 胶囊的选中答案。全部样式使用 `ui-theme` 令牌。

## 备选方案

- **`append()` 写入派生 `project_activity` 表**：不需要——`conversation_events` 已保存带署名消息 JSON，认领连接已覆盖回答。第二条写路径只会重复数据并增加回填成本。
- **记忆 / 面向模型的召回**：本功能拒绝。把提取的摘要喂给模型会引发压缩后署名、私有会话泄漏、执行参与者认定等仓库尚未解决的问题。feed 完全在模型路径之外。
- **审批进入 feed**：设计评审时移除；feed 的目标是快速看懂成员输入与选择，审批噪音背道而驰。
- **自动化行（定时 / webhook 运行）**：推迟到独立的自动化健康视图；`conversation_search` 的 `source.kind === 'user'` 过滤已将它们排除在本 feed 之外。

## 影响

- 一次增量迁移（`call_id`）、两个认领面上的可选参数、一条 Gateway GET 路由、一个新客户端插件包、一个 viewport 新方法。无 session-format 变更，无模型可见变更，无对话业务逻辑变更。
- 历史提问回答在认领携带 `call_id` 之前显示回答者 + 选中答案，不带提问关联。
- reveal 机制惠及未来任何深链能力。

## 需要的验证

- `listActivity` 的 Postgres 测试：消息署名、回答连接与提问提取、可见性排除（私有、非成员、steward 门禁）、keyset 分页顺序、`call_id NULL` 兜底。
- 客户端插件的 REAL-composition 测试与面板的 keyless Web 场景（分组、筛选、跳转 affordance、空态）。
- `reveal` 由客户端测试覆盖（聚焦 + 滚动请求发布）；ChatView 的消费走既有 navigation 契约测试。
