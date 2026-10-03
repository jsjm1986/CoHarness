# Agent Note：消除 admin UI 与网关服务端契约的漂移

状态：已实现

[English](2026-10-04-admin-ui-server-contract-drift.md) | 中文

## 问题

对 `gateway/admin-ui` 每个请求与 `gateway/src/admin-api.ts` 处理器的逐项契约审计发现了四处类型系统抓不到的漂移：

- Webhook 编辑器把已停用用户列为执行账号，且在 `runtimeKind: 'user'` 时允许运行时目标与执行账号不一致；投递两者都拒绝，user 目标组合实际上永远无法派发。
- Webhook 与 SSH 编辑器会把服务端 schema 必然拒绝的值直接发出（必填文本为空、非 `owner/repo` 的仓库筛选、超出服务边界的数值、相对路径、非法主机别名），管理员只能在保存后收到笼统的 400。
- `setMaintenance` 声明返回 `DeploymentState`，而 `POST /admin/api/deployment/maintenance` 实际返回不含 `migrations`/`operations` 的裸集群状态。
- `ProfileSettingsController` 恒把 `bundles`/`rows` 发布为空集，管理页的「已配置」徽标与行级配置标记永远无法点亮。

## 决定

在表单边界镜像服务端约束，并从 wire 数据推导 ledger 事实。Webhook 编辑器把执行账号与 user 运行时目标过滤到 `status === 'active'`，user 运行时目标固定为执行账号，并按 `webhook-endpoint-service` 的边界逐字段校验（必填文本上限、64 项筛选、`owner/repo` 仓库名、数值上限）。SSH 编辑器同样套用 `ssh-target-service` 的边界，包括绝对路径与主机别名模式。`setMaintenance` 返回新抽出的 `ClusterState` 接口（`DeploymentState` 继承它），与路由实际应答一致。设置 ledger 按 `rowConfigKey` 约定从配置键推导 `bundles` 与 `rows`：`bundle#rowId` 标记一行及其包，裸 `bundle` 只标记包。

## 文件

- `gateway/admin-ui/src/pages/WebhooksPage.tsx` — 活跃账号下拉、user 目标锁定、镜像服务 schema 的字段校验。
- `gateway/admin-ui/src/pages/SshPage.tsx` — 名称、主机别名、绝对路径与数值上限的后端边界校验。
- `gateway/admin-ui/src/api.ts` — 抽出 `ClusterState`；`setMaintenance` 返回它。
- `gateway/admin-ui/src/plugins/settings-store.ts` — 从命名空间键推导 `bundles`/`rows`。
- `gateway/admin-ui/src/pages/WebhooksPage.spec.tsx`、`gateway/admin-ui/src/plugins/settings-store.spec.ts` — 覆盖新推导与停用账号过滤。

## 影响

表单在本地拒绝服务端会远程拒绝的值，保存错误描述真实约束而不是笼统的 `invalid webhook endpoint`/`invalid ssh target`。编辑执行账号后来被停用的端点会呈现空选择并强制重选一个活跃账号，与投递校验一致。任一服务 schema 新增约束仍需手工同步对应表单校验。
