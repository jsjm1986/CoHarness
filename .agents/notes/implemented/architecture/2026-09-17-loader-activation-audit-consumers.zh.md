# Agent Note：消费者改为审计激活，而非捕获事务回滚

Status: implemented

[English](2026-09-17-loader-activation-audit-consumers.md) | 中文

> 将 [app-boot 非事务重载适配](../../../../packages/boot/app-boot/README.zh.md) 应用到 dsh-v0.1.6-alpha.1 迁移中其余的 Loader 消费者。

## 问题

vendored Cordis 升级移除了事务性 Loader 承诺：组合过程中某个条目失败时，插件树不再回滚到先前的树。条目级失败——导入错误、配置校验拒绝、`apply` 抛出——会把失败记录在该条目的 fiber 上（`FiberState.FAILED`）或让条目保持未加载，而无关条目照常激活、`loader.await()` 正常解析。按旧契约编写的消费者与测试以三种方式损坏：

- 对如今会解析的组合使用 `rejects.toThrow(...)`；Vitest 的 pretty-format 打印解析出的 `Context` 代理时崩溃于 `cannot get property "$$typeof" without inject`，掩盖了真实的行为变化。
- TypeScript 拒绝对返回 void 的 Loader API（`Fiber.update()`、`EntryTree.remove()`）调用 `.catch()`/`await`。
- 笔记与测试仍引用 `hmr-config.spec.ts`——其覆盖移入 `watch-config.spec.ts` 时该文件已删除。

## 决策

消费者改为观察激活，而非捕获回滚，与 app-boot 的启动审计一致（自 dsh-v0.1.6-alpha.2 起为 `auditStartupEntries`——上游以 `StartupError` 加结构化 `inactiveEntries` 诊断的形式采纳了同一模型）：

- `packages/client/web/src/boot-client.ts` 将失败路径留在审计内：模块无法导入的行在 Loader 中记录失败，启动页把该行报告为 `failed`，`assertEntriesActive` 以 `N entr… did not activate` 报告拒绝启动。
- `packages/todo/tool-todo/tests/loader-composition.spec.ts` 钉住无回滚的误配置：`allowParallelInProgress` 缺失或非布尔时，工具条目的 fiber 到达 `FiberState.FAILED` 而树的其余部分照常激活，`todo_write` 永不挂载。
- `packages/extensions/cordis-client-runner/src/client/runtime.ts` 在移除前保留条目的 fiber，并等待其卸载完成。延迟清理路径收容移除错误，并始终释放注入的样式。
- 引用 `hmr-config.spec.ts` 的四份双语笔记改指其继任者 `watch-config.spec.ts`。

directory-picker-auto 选择器在导入后的条目没有 fiber 时使自身 fiber 失败，不重试导入。它移除自己拥有的两个条目并等待其 fiber 卸载完成，包括已被树移除的条目。组合测试验证失败后服务不存在，以及卸载时等待延迟资源释放。

## 备选方案

**在 app-boot 用事务包装恢复组合拒绝。** 拒绝：这会重新引入上游升级刻意移除的回滚保证，并偏离 vendored Loader 的可观察行为。

**只断言 fiber 内的错误文本。** 拒绝：树级失败不填充 `fiber.error`，且消息文本是比激活审计已拥有的条目状态更弱的契约。

## 后果

- `loader.await()` 解析不再蕴含激活；每条启动路径此后审计或渲染逐条目状态。
- 面向 Loader 的移除与更新调用在调用点解包；清理逻辑不得依赖可等待的移除。
- 载入期拒绝断言改为 fiber 状态断言加下游服务缺失检查；旧失败文本只作为 apply 错误保留在 fiber 内。
- 已验证落地：`cordis-client-runner` 的 `tsc -b` 退出码 0；`runner.client.spec.ts`（31）、`boot-client.client.spec.ts`（6）、`tool-todo/loader-composition.spec.ts`（4）定向套件全绿。第一阶段收口：Python 3.12 下 `pnpm run test` 退出码 0（1067 文件、18075 项、116 跳过），`pnpm run build` 与 `pnpm run typecheck` 退出码 0；vendored HMR 配置监听（Chokidar 4.0.3）在同一全量中通过全部 11 项原生用例，此前三条 5 秒超时文件的定向串行（42）与 verbose（9）复跑均通过，未修改超时、断言或超时配置。