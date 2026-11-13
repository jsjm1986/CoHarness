# Agent Note: 让受管 Cua Driver 排在资源准入之后

状态：已实现

[English](2026-11-13-cua-driver-resource-budget-inject.md) | 中文

## 问题

在配置了桌面的节点上，每个受管 runtime 都挂载 `computer-use-cua-driver-mcp`，也都以同一种方式失败：驱动的 managed stdio 传输层通过 `subprocess` 派生 MCP 子进程时，`resourceBudgetOf` 在 `gateway-resource-budget` 提供方完成其异步 `Service.init`（一次发往 `/internal/runtime/resources/register` 的 POST）之前读取 `ctx.get('resourceBudget')`；而 Cordis 对 fiber 未达 ACTIVE 的提供方返回 `undefined`。由于 `gateway-runtime` 发布了 `resourceBudgetRequired`，该查找抛出 `ResourceAdmissionError: Managed execution requires its resource admission provider`，驱动的 `apply` 被拒绝，Cordis 回滚该提供方，`desktop.status` 在整代内报告不可用。这是确定性的顺序缺陷而非竞态：插件只声明了 `inject = ['computerUse', 'tools']`，没有任何机制把它的激活推迟到准入存在之后。

## 决策

[managedDesktopPatch](../../../../gateway/src/launch-stamp.ts) 现在为 `computer-use-cua-driver-mcp` 条目发出 `inject: [resourceBudget]`。条目级 inject 经 `Inject.resolve` 与插件自身的 `inject` 导出合并，因此该条目只在 `resourceBudget` 进入 ACTIVE——即其 register POST 已完成——之后才激活，传输层的首次派生面对的是已就绪的提供方。该声明放在 Gateway 受管 patch 而非包的 `inject` 导出中：准入提供方仅在受管组合中是必需的，合法省略 `resourceBudget` 的独立组合因此保留插件原有的激活契约。同一生成 patch 中始终存在 `gateway-resource-budget`，新依赖边不可能悬空。

## 曾考虑的方案

- **把 `resourceBudget` 加进包的 `inject` 导出。** 该包也会运行在根本没有预算提供方的组合里，这条边会让激活永久停滞；只有 Gateway patch 才知道准入是必需的。
- **在 `ManagedStdioTransport` 内部延迟。** 重试 `ctx.get` 等于在消费者里重新实现 inject 排序，且仍在猜提供方就绪时机；声明依赖正是注入机制的用途。
- **改为注入 `gateway-resource-budget` 的插件 id。** 注入按服务名而非插件名；服务键才是其它提供方也能满足的稳定契约。

## 影响

准入先行后，首次派生获取真实租约而不再 fail-closed，提供方回滚也不再让整代失去 computer use。准入本身无法初始化的环境——例如 register POST 失败——现在表现为驱动条目挂起而非在派生内部报错；runtime 日志显示的是待激活条目而非已回滚的提供方。修复已在生产中验证：同一台原本每次启动都记录 `ResourceAdmissionError: Managed execution requires its resource admission provider` 的 runtime，在 inject 生效后推进到了资源排队阶段（节点满载时表现为 `Resource admission expired`）。

## 验证

[instances.spec.ts](../../../../gateway/tests/instances.spec.ts) 断言生成的 `cordis.patch.yml` 在驱动条目上携带 `inject: [resourceBudget]`，同时保留并列的 command/args 覆盖节。生产节点的受管 runtime 重启提供了实证：打过补丁的条目等到准入后走到了注册路径。
