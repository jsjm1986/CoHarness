# Agent Note: 项目动态记录——面向人的成员输入视图

Status: implemented

[English](2026-10-17-project-activity-feed.md) | 中文

## 问题

共享项目 runtime 承载多个成员的多个会话。现在回到项目的成员只能通过翻完整对话、或直接问 agent，才知道队友做了什么。用户输入早已带参与者署名落库，但缺少一个能回答「谁说了什么、选了什么」的面向人的视图。本笔记把这个视图设计为右侧栏面板，不引入面向模型的记忆。

## 决定

新增**项目动态记录**：`ui-project-activity` 客户端插件，按三种维度（时间 / 会话 / 成员）分组展示当前项目的成员消息与提问回答，并支持跳转到对应消息。面板后来增加了第四个、默认的 `进展` 档，渲染[面向人的项目进展纪要](2026-10-21-project-progress-journal.zh.md)；三种 feed 分组仍是其原始视图。

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

Gateway 新增 `GET /account/api/activity?before=<keyset>&limit=<n>`，与 `/account/api/conversations` 并列。处理器要求调用者的账户 scope 已解析为项目，对所属根会话应用 `listConversations` 的可见性条件，返回规范化的 `ProjectActivityItem` 列表。浏览器与其他协作读操作一样携带会话 cookie 调用。

### 客户端

- `packages/client/ui-project-activity` 注册 `sidebarRightTabs` 标签类型以及 `sidebar.right.pane.tab`、`sidebar.right.pane.tab.title` 插槽，与 `ui-sidebar-terminal` 同形。web-app 组合中的行保持启用；apply 体订阅 `projectUiPolicy`，在每次 scope 切换时挂载或释放标签定义——Guide 入口与已打开的标签只在项目空间出现，没有按空间划分的静态补丁。
- 面板通过包内私有 `fetch` 客户端（`credentials: 'same-origin'`）拉取；路由从调用者的活动账户 scope 解析项目，projectId 不上线路。
- 跳转分两级：点会话名聚焦或打开窗格（`conversationViewport.replaceActive`）；点条目调用新增的 `ConversationViewport.reveal(sessionId, seq)`——viewport 聚焦窗格并发布 reveal 请求；所属 `ChatView` 经 inject `hooks` 面订阅，定位包含该 `seq` 的 turn，经既有 `loadHistoryUntil` 加载历史并滚动到对应行。Feed 行携带线路 sessionId；插件先经 `sessions.keyFor` 翻译为 runtime 作用域的客户端标识，再调用这两个方法。这是本次唯一新增的跨插件能力。

### 呈现（已评审 HTML 稿）

每个分组是一种折叠阅读视图：`time` 按日折叠（今天默认展开），条目为单行摘要，点行就地展开详情卡——含提问原文、完整内容与「跳到会话」；`conversation` 每会话一个折叠块，块头为色点+标题+最近时间，摘要行优先呈现最新回答（「定了：提问 → 答案（谁）」），元信息行带参与人头像、条数与决定数；`member` 每人一个折叠块（头像+姓名+条数+决定数），摘要行先列「定了」再列「说了」。会话色点由 `sessionId` 哈希固定五色。回答行动词化为 accent「定了」，消息为普通文本；行点击仍 `reveal(sessionId, seq)`，会话 chip 点击 `reveal(sessionId, null)`。折叠态为组件本地状态。工具条、筛选、刷新、分页不变；全部样式使用 `ui-theme` 令牌。

## 备选方案

- **`append()` 写入派生 `project_activity` 表**：不需要——`conversation_events` 已保存带署名消息 JSON，认领连接已覆盖回答。第二条写路径只会重复数据并增加回填成本。
- **记忆 / 面向模型的召回**：本功能拒绝。把提取的摘要喂给模型会引发压缩后署名、私有会话泄漏、执行参与者认定等仓库尚未解决的问题。feed 完全在模型路径之外。同一问题指向的面向人的梳理后来单独落地为[项目进展纪要](2026-10-21-project-progress-journal.zh.md)，其条目同样不进入任何模型请求。
- **审批进入 feed**：设计评审时移除；feed 的目标是快速看懂成员输入与选择，审批噪音背道而驰。
- **自动化行（定时 / webhook 运行）**：推迟到独立的自动化健康视图；`conversation_search` 的 `source.kind === 'user'` 过滤已将它们排除在本 feed 之外。

## 影响

- 一次增量迁移（`call_id`）、两个认领面上的可选参数、一条 Gateway GET 路由、一个新客户端插件包、一个 viewport 新方法。无 session-format 变更，无模型可见变更，无对话业务逻辑变更。
- 历史提问回答在认领携带 `call_id` 之前显示回答者 + 选中答案，不带提问关联。
- reveal 机制惠及未来任何深链能力。

## 测试

- `packages/client/ui-project-activity/tests/apply.client.spec.ts` 覆盖 scope 门控的标签注册/释放、分组、成员筛选、分页，以及 reveal 的 `sessions.keyFor` 翻译。
- `apps/web/tests/project-activity.e2e.ts` 在 mock Gateway 上启动真实 Web 组合，种子化一个会话，渲染 feed（消息、提问、选中回答），并点击行落到对应日志事件。
- `listActivity` 的 SQL 语义（可见性条件、回答连接、keyset 顺序）由 CI 的 Gateway Postgres 通道运行。
