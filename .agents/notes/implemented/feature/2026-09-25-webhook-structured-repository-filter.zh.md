# Agent Note: Webhook 端点携带在受理入口强制生效的结构化仓库筛选

Status: implemented

[English](2026-09-25-webhook-structured-repository-filter.md) | 中文

## 问题

受管 Webhook 端点此前只按事件名与 `payload.action` 筛选投递。投递所属仓库只能出现在标题/提示词模板里，没有批准的结构化筛选：一个组织级 webhook 用同一密钥给名下全部仓库签名时，端点未选择接收的仓库也会触发会话派发。审计要求筛选配置贯通到执行路径——同一签名密钥下不匹配仓库的投递被拒绝——而不是只在模板中说明该字段。

## 决策

**端点在 `events`/`actions` 之外保存 `repositories` 规则，在为该投递预留任何运行时工作之前由 `GatewayWebhookIntake.dispatch()` 评估。**

- 迁移 [042](../../../../gateway/deploy/postgres/migrations/042_webhook_repository_filter.sql) 为 `harness.webhook_endpoints` 增加 `repositories text[] NOT NULL DEFAULT '{}'`（基数 ≤ 64）；既有行默认空列表，保持接收全部仓库。
- 注册时把每个条目校验为结构化 `owner/repo` 完整名（`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`，≤ 128 字符）；其他形态在 create/update 处即返回 400，到不了受理路径。
- `dispatch()` 把已验证载荷的 `repository.full_name` 与配置条目做大小写不敏感比较，与 GitHub 仓库命名的大小写语义一致。配置了筛选即失败关闭：`full_name` 缺失、畸形或不匹配都不派发。
- 筛选未命中记录 `state: 'ignored'` 并附带指明未命中规则的 `errorCode`（`event-unmatched`、`action-unmatched`、`repository-unmatched`）。回执表本已存储 `error_code`，管理端投递视图本已渲染它，因此被排除的投递现在显示是哪条结构化规则排除了它，而不是一个无解释的忽略。
- 管理端端点表单以逗号分隔的 `owner/repo` 条目编辑该列表，端点表显示已配置仓库。`repositories` 与其他规则走同一条 revision 校验更新与 `dispatchConfig` 路径，管理员重跑按当前筛选重新评估。

## 备选方案

**仓库不匹配记 `rejected` 回执。** rejected 表示派发尝试被运行时边界拒绝（运行时离线、账号停用、模板不可解析）。组织级 webhook 合法地为同一签名下的全部仓库投递事件，其中绝大多数被端点主动排除属常态，因此筛选未命中保持 `ignored`——reason code 承载诊断，不夸大故障。

**通用载荷路径筛选（任意 `a.b.c` 等于 `x`）。** 否决：自由的路径/值语言是变相的模板求值器。三个具名字段满足批准要求的结构化契约，也让校验、索引和界面保持具体。

**属主前缀或通配条目（`acme/*`）。** 作为推测性面否决：批准的要求是按完整名匹配仓库。精确条目语义直白；属主级规则今天可逐仓库列出表达。

## 后果

同一密钥下来自不匹配仓库的投递现在记录一条带 `repository-unmatched` 的 `ignored` 回执，永远到不了绑定的运行时；匹配行为在 PostgreSQL 受理套件中端到端验证，同时覆盖大小写不敏感接受、字段缺失失败关闭、非法条目注册拒绝与更新往返。迁移前创建的端点保持接收全部行为，直到管理员收窄。来自 [Webhook 执行身份笔记](../architecture/2026-09-23-webhook-execution-identity.zh.md) 的投递身份与执行账号契约不变：筛选发生在签名验证与持久预留之后、受管派发调用之前。
