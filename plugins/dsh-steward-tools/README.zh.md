# @deepseek-ai/dsh-steward-tools

[English](README.md) | 中文

保留的常驻 **steward** 维护运行时的工具面：一条进入部署 PostgreSQL 数据库的受审计 SQL 通道。Gateway 只把本包挂载到 steward 项目的运行时上（`HGW_STEWARD_TOOLS_PACKAGE`);其他任何运行时 profile 都看不到它。

## 功能

- 注册 `steward_query`：经运行时自身的回环凭证调用 `POST /internal/runtime/steward/query` 执行一条 SQL（凭证材料不进入工具面）。
- 读语句(`SELECT`/`WITH`/`VALUES`/`TABLE`/`SHOW`/`EXPLAIN`）直接执行；其余语句先经会话内审批通道询问操作员，获批后把审批 id 一并交给 Gateway，由 Gateway 对照 `conversation_interaction_responses` 复核后再执行。
- `dry_run` 返回语句的 `EXPLAIN` 计划而不执行——写语句同样适用，因为不落任何改动，无需审批。
- `row_limit` 限制返回的读取行与 dry-run 计划行。Gateway 的结果大小限制可能更早截断任一种响应；工具会明确标记被截断的计划和读取结果。
- 取消工具会结束它到 Gateway 的请求。对 Gateway 已受理的语句，以 Gateway 记录的结果为准。
- 每次尝试——读、拒绝、失败、应用——都由 Gateway 记入 `harness.steward_query_log`。
- 注册 `steward:policy` 系统提示词节区，让模型知道自己运行在维护通道：受审计 SQL、只读事务、会话内写批准、留痕。

## 边界（如实限制）

- 工具和 Gateway 使用同一个语句分类器。修改数据的 CTE 或外层写语句进入审批通道。只读 CTE 使用读取通道。Gateway 对提交的 SQL 重新分类，并执行事务模式、精确审批绑定和语句上限检查。
- 工具无法制造审批：没有已批准的会话内审批，写操作失败关闭；审批 id 通过 `callId` 绑定到发起会话。
- steward 运行时不能变更自身插件组装；`steward_query` 由部署 patch 挂载，不经过插件管理。
- SQL 之外的管理操作（release 激活、运行时重启）不在本包暴露；由操作员在管理面执行。

## 测试

`tests/query.spec.ts` 覆盖语句分类与审批提示预览；`tests/composition.spec.ts` 覆盖注册、注销，以及有截断和无截断情况下的真实 dry-run 工具执行。执行器契约由 `steward-query.ts` 旁的 Gateway 测试覆盖。

无密钥的 [steward-query-truncation 快照](../../snapshots/session/steward-query-truncation/snapshot.yml)通过随产品提供的 headless profile 加载插件源码，并将截断计划记录为模型可见的工具结果。从仓库根目录运行 `DSH_EXAMPLE_MODE=src DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t steward-query-truncation` 回放。
