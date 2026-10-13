# Agent Note: Account preferences carry every ui-conversation field

Status: implemented

[English](2026-10-12-account-conversation-view-preferences.md) | 中文

## Problem

`ui-conversation` 设置命名空间注册为 `owner: 'account'` 且 `projectWrite: 'never'`，浏览器通过 `account-or-host` 作用域绑定它，使每位成员的展示选择即使在共享的项目运行时内也按账户持久化。然而账户偏好线协议只接受 `busyEnter`、`chatContentWidth`、`chatFullWidth` 与 `chatFontSize` 四个字段。后来加入 schema 的三个字段——`transcriptView`（工作步骤展示）、`performanceUsage` 与 `linkOpening`——从未进入 `AccountPreferenceMutation['field']`、`ACCOUNT_FIELDS` 白名单、Gateway 校验器或 `harness.user_preferences` 表。

在项目作用域内，合并作用域因账户腿活跃仍报告该命名空间可写，但 `route()` 把这三个字段送往 Host 作用域，而 Host 对项目参与者拒绝账户级写入。于是行内的选择器表现为可用、选择看似生效，而写入以 `blocked` 结束并显示"账户存储暂时不可写"——一个静默失效的偏好，正是 chat-full-width 笔记警示过的字段滞后于账户路径的失败形态。

## Decision

账户偏好协议现在承载完整的 `ui-conversation` 字段集。迁移 `055_conversation_view_preferences.sql` 新增可空的 `transcript_view`、`performance_usage` 与 `link_opening` 列，检查约束与可写取值一致。Gateway 类型联合、`normalizeAccountPreferenceMutation`、Postgres 服务的行投影／变更列映射／legacy 读取器、浏览器传输的字段联合与解析器、以及 `ACCOUNT_FIELDS` 全部接受这三个字段。legacy `settings.yaml` 值按 schema 自身的折叠迁移：`normal` 与 `expanded` 两个旧 transcript 模式存为 `detailed`，与 Host schema 读取它们时的展示一致。

unset 将列清为 NULL,values 视图回落到产品默认值（`detailed`、`detailed`、`sidebar`)，因此无论由哪一层回答，各界面看到的有效值一致。七个 schema 字段全部进入白名单后，账户腿对整个命名空间权威；Host 层现在只贡献端点未持有的键。

让该失效状态得以隐藏的是共享 `Modal` 基元：prop 文档早已承诺 `contentClassName` 是可滚区域，但 `overflow-y: auto` 只存在于紧凑视口媒体查询内，且 `.dialog` 在桌面端没有高度上限。桌面弹窗内容一旦超过上限就把正文裁剪进页脚。基础规则现在把卡片限制在留白的视口盒内并在所有视口上滚动 `.content`，同时 `.footer` 保持固定。

## Alternatives considered

**让字段继续走 Host 路由并润色只读文案。** 所有权元数据早已把这些偏好声明为账户级；项目成员无法修改个人展示偏好是错误的产品答案，而账户通道存在的意义正是在共享项目运行时中写账户数据。

**放宽该命名空间的 `projectWrite`。** 把成员个人取值写进共享的项目设置文档会让一位成员的偏好泄漏给其他所有成员，直接违背 `owner: 'account'` 的声明。

**不加迁移直接扩线协议。** 用 JSONB 偏好大对象可以省掉 DDL，但放弃了迁移 020/023/026 已确立的逐字段列＋检查约束模式，也丢掉 revision 模型依赖的单语句栅栏更新。

## Consequences

`transcriptView`、`performanceUsage` 与 `linkOpening` 的写入在任意作用域——个人或项目——都能通过 `PATCH /account/api/preferences` 生效，与其他字段同享一条账户 revision 栅栏。项目作用域内的选择器行不再渲染 blocked 提示。Gateway 与客户端必须同版发布：新客户端对 055 之前的 Gateway 收到的仍是窄字段联合，相关变更会被 `invalid-account-preference` 拒绝；部署在一次发布中同时升级两者。

今后每新增一个 `ui-conversation` 偏好字段都有完整清单可走：schema、线协议联合、白名单、校验器、列、视图、解析器与测试替身——第一次滞后教训换来的七层清单。

## Verification

`gateway/tests/account-preferences.spec.ts` 通过 HTTP 路由接受一次 `transcriptView` 写入，并在服务执行前拒绝 legacy 模式值。`gateway/tests/postgres.spec.ts` 把 legacy `normal` 模式迁移为 `detailed`，并通过真实列路径写入新字段。connection 规格解析新字段、为旧响应套用默认值，并在 values 与 overrides 两层拒绝非法枚举。account-scope 规格验证白名单字段路由到端点、未列名键仍写入 Host 作用域，且账户 override 标记出现在合并后的 `user` 层。

## Related

[Chat content width carries a separate persisted fill flag](../feature/2026-09-16-chat-full-width-preference.zh.md) 记录了同一条账户偏好路径——正是那个字段最早暴露了此类失败模式。
