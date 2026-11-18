# Agent Note：工具 describe 暴露 executor 传输层工具

状态：已实现

[English](2026-11-16-tools-describe-executor-transport-surface.md) | 中文

## 问题

上游 rc.3 把 PTC `run_code` 工具从注册层移入所选 executor 的传输面。此后 `ctx.tools.schemas(scope)` 只返回已注册定义：PTC 模式下检查 provider 列出了已注册的嵌套工具，却漏掉了调用方唯一能真正调用的工具；同时系统提示通过私有 `describe` 路径触达 executor，其他消费者无法复用。任何需要完整模型可见工具面的消费者都不得不重复推导同一个并集。

## 决策

- `ToolsService.describe(scope?, toolSet?)` 转为公开方法，成为模型可见工具视图的唯一来源：它为作用域选择 executor，返回其 `ToolModelInput`，并在 executor 未给出 `knownNames` 时用可见注册层补齐。系统提示集成改为调用此方法，不再使用内联闭包。
- `Tool` Cordis Inspector provider 将 `ctx.tools.schemas(agent)` 与 `ctx.tools.describe(agent).schemas` 求并集、按工具名去重，且只吞掉 `ToolExecutorUnavailableError`，使无 executor 的组合仍能列出已注册工具。

## 后果

- PTC 模式下 `cordis_inspect_query`/`cordis_inspect_list` 会把 `run_code` 与已注册工具一并展示，而不把它伪装成注册定义。
- 公开 API 面新增一个方法；生成的 Cordis API 目录与子系统文档携带其签名。

## 曾考虑的替代方案

- 把 `run_code` 注册为普通工具——否决：传输工具归 executor 所有，假注册会产生第二条可被绕过的调用路径。
- 把并集只留在 Inspector provider 内部——否决：之后的每个消费者都要对着私有 describe 路径重复同一合并。

## 验证

- `packages/core/tools/tests/tools.spec.ts`：三个用例覆盖合并视图、注册层之外的 executor 传输 schema 暴露，以及无 executor 报错。
- `apps/cli/tests/profiles/headless/tests/ptc.e2e.ts` 通过：PTC 检查报告 `run_code` 加各 cordis 工具。
- `pnpm run test:snapshot` 379/380 通过：刷新了 `cordis-inspect-jsdoc` fixture，其经审查的 diff 仅含新增 `describe` 签名。
