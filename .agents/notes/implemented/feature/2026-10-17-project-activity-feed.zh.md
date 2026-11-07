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

审批、权限模式切换、自动化运行、未读标记、通知均不在范围。私有会话仅向创建者或组织管理员展示；面板沿用 `listConversations` 的可见性 SQL。

### 派生方式：查询时计算，不建派生表

每个字段都已在持久化存储中，feed 是一次分页读，不是新的写路径：

- 消息来自 `conversation_events`（`event_type='user/message'`），该表存有含 `source.participant` 的完整事件 JSON。
- 回答将 `conversation_interaction_responses` 按 `call_id` → `event->'data'->>'callId'` 连接 `conversation_events`，已有部分索引覆盖。提问原文来自对应 `tool/call` 事件的 arguments；seq 锚点来自 `tool/result` 行。

唯一的持久化缺口是认领行上的 `callId`：`question/requested` 在传输中携带 `wait.callId`，但不是已记录的会话事件，认领时 rpcId↔callId 的关联丢失。迁移 056 给 `conversation_interaction_responses` 增加 `call_id text NULL`；`execution.answer` / `claimInteraction` 增加可选 `callId`，由 api-proxy 从 `pending.wait.callId` 填入。迁移之前的认领 `call_id` 为 NULL，显示为「问题无法定位」——回答者与答案照常显示，但没有跳转和提问原文。

### 服务端

Gateway 新增 `GET /account/api/activity?before=<keyset>&limit=<n>`，与 `/account/api/conversations` 并列。处理器要求调用者的账户 scope 已解析为项目，对所属根会话应用 `listConversations` 的可见性条件，返回规范化的 `ProjectActivityItem` 列表。浏览器与其他协作读操作一样携带会话 cookie 调用。

游标是不透明的版本化值，包含 PostgreSQL 完整微秒时间、Session id、日志锚点及单条动态标识。继续读取的比较条件与时间降序、Session id 升序、锚点降序、动态标识升序一致。最后一项标识可区分同样缺少日志锚点的历史回答。带分隔符的 Session id 会完整保留。旧式毫秒游标仍可读取；无效游标读取第一页。历史回答数组中非对象元素不贡献摘要文本；响应仍保留原始 outcome。

### 客户端

- `packages/client/ui-project-activity` 注册 `sidebarRightTabs` 类型及带 key 的正文、标题插槽。注册跟随当前会话的项目 Runtime，因此从个人启动页面打开项目会话时仍提供活动入口。未限定 Runtime 的独立会话使用页面策略。正文在生命周期内保留所属会话身份，以 `dshRuntime`、`dshTarget` 限定 Feed、纪要和生成请求；另一标签的空间 cookie 不能重定向它们。Gateway 继续负责检查当前访问权限。纪要轮询只有一个有限窗口，仍在生成的响应不会重启轮次预算。已被新刷新替代的读取不能再发布结果，包括 JSON 解码之后。
- 请求经同源账号 cookie 认证，显式 Runtime 参数不授予访问权限。[带 Runtime 的 Session 决策](../architecture/2026-09-27-runtime-qualified-client-sessions.zh.md)定义共用浏览器寻址和账号生命周期隔离。
- 会话名调用 `conversationViewport.replaceActive`，带锚点的行调用 `ConversationViewport.reveal(sessionId, seq)`。所属 Chat 视图经 `loadHistoryUntil` 加载历史并滚动到该事件。Feed 中的会话 ID 只在 Host 内有效，因此 `sessions.keyFor` 必须接收正文捕获的完整 Runtime，包括 UUID。浏览器汇集多个 Runtime 连接时，仅项目限定的键不能标识一个分配。

### 呈现（已评审 HTML 稿）

每个分组是一种折叠阅读视图：`time` 按日折叠（今天默认展开），条目为单行摘要，点行就地展开详情卡——含提问原文、完整内容与「跳到会话」；`conversation` 每会话一个折叠块，块头为色点+标题+最近时间，摘要行优先呈现最新回答（「定了：提问 → 答案（谁）」），元信息行带参与人头像、条数与决定数；`member` 每人一个折叠块（头像+姓名+条数+决定数），摘要行先列「定了」再列「说了」。会话色点由 `sessionId` 哈希固定五色。回答行动词化为 accent「定了」，消息为普通文本；行点击仍 `reveal(sessionId, seq)`，会话 chip 点击 `reveal(sessionId, null)`。折叠态为组件本地状态。工具条、筛选、刷新、分页不变；全部样式使用 `ui-theme` 令牌。

分组键使用稳定的会话或成员 ID。把名称与 ID 拼接会产生冲突，并拆散改名后的同一身份；按新到旧排列的首行提供显示信息。

日历标签使用查看者的本地日期。夏令时切换可能使一个日历日持续 23 或 25 小时，因此不能通过向前偏移 24 小时来确定昨天。

## 备选方案

- **`append()` 写入派生 `project_activity` 表**：不需要——`conversation_events` 已保存带署名消息 JSON，认领连接已覆盖回答。第二条写路径只会重复数据并增加回填成本。
- **记忆 / 面向模型的召回**：本功能拒绝。把提取的摘要喂给模型会引发压缩后署名、私有会话泄漏、执行参与者认定等仓库尚未解决的问题。feed 完全在模型路径之外。同一问题指向的面向人的梳理后来单独落地为[项目进展纪要](2026-10-21-project-progress-journal.zh.md)。
- **审批进入 feed**：设计评审时移除；feed 的目标是快速看懂成员输入与选择，审批噪音背道而驰。
- **自动化行（定时 / webhook 运行）**：推迟到独立的自动化健康视图；`conversation_search` 的 `source.kind === 'user'` 过滤已将它们排除在本 feed 之外。
- **仅用毫秒时间与日志锚点作为游标**：PostgreSQL 回答时间保留微秒，历史认领可能同样缺少锚点。截断时间或省略单条动态标识会使分页丢失记录。

## 影响

- 一次增量迁移（`call_id`）、两个认领面上的可选参数、一条 Gateway GET 路由、一个新客户端插件包、一个 viewport 新方法。无 session-format 变更，无模型可见变更，无对话业务逻辑变更。
- 历史提问回答在认领携带 `call_id` 之前显示回答者 + 选中答案，不带提问关联。
- reveal 机制惠及未来任何深链能力。

## 测试

- `packages/client/ui-project-activity/tests/apply.client.spec.ts` 覆盖 scope 门控的标签注册/释放、分组、成员筛选、分页，以及 reveal 的 `sessions.keyFor` 翻译。
- `apps/web/tests/project-activity.e2e.ts` 在 mock Gateway 上启动真实 Web 组合，种子化一个会话，从第二个标签页更改共用作用域 cookie，刷新原项目 feed，固定其 UI 快照，并点击行落到对应日志事件。
- 真实 Gateway HTTP/PostgreSQL 快照覆盖时间并列、微秒间隔、无锚点回答、带分隔符的 Session id、新旧及无效游标、消息与回答混合分页、历史回答中的无效元素。
- 浏览器回归通过时间与会话视图，覆盖 `America/New_York` 中持续 23 小时和 25 小时的本地日期。

编译产物的分页诊断使用四个根会话、100 条消息、100 条回答和每页 50 行，在 Node 25.8.1/macOS arm64 上经本机连接 PostgreSQL 17.6，连接池大小为一，每个版本使用三个独立进程，十次预热后运行三批，每批 30 次。首屏耗时中位数为 10.715 → 11.166 ms，峰值 RSS 为 69,664 → 69,712 KiB，GC 后 RSS 为 69,584 → 69,616 KiB。翻页耗时为 9.241 → 9.606 ms，峰值 RSS 为 69,392 → 69,744 KiB，GC 后 RSS 为 69,408 → 69,664 KiB。测量不含 HTTP、数据库服务端内存及并发。构建后，在 Gateway 目录选择可丢弃的 `HGW_TEST_DATABASE_URL`，运行 `HGW_ACTIVITY_PERF_BASELINE_REF=2896f75419ca38682a4a96151ee15beee009ccac TSX_TSCONFIG_PATH=tsconfig.run.json node --import tsx/esm tests/project-activity.perf.ts`；脚本编译该原始源码，在原生 Node 中测量两个编译实现。
