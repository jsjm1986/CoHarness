# Agent Note：hmr-live 将 dev:web 与 lane 的客户端产物隔离

状态：implemented

[English](2026-10-21-dev-web-skip-build-artifact-isolation.md) | 中文

## 问题

`hmr-live.e2e.ts` 从 Vitest worker 启动 `pnpm run dev:web`，以验证真实的客户端插件编辑能够热重载。`dev:web` 在启动 watcher 之前会先跑 `build:artifacts`，而该 spawn 继承了 worker 的 `NODE_ENV=test`：这一阶段产出的是 test 模式的 bundle，并用它们的摘要是写 `.dsh-build/client-build-environment.json`；测试随后对 `lib/client*.js` 与 `apps/web/dist` 做的字节恢复，永远无法匹配这一阶段留下的 record。pool lane 中之后的每个 record 消费者——首先是 `built-boot.snapshot.ts`——都会因产物摘要不匹配而失败。即使没有 build 阶段，还存在第二个更隐蔽的泄漏：旧的 teardown 在 watcher 仍然存活时就恢复了被编辑的 `locales.ts`，恢复动作本身会再排进一次重建，其 emit 可能在产物恢复之后才落盘，留下 watch 模式的 bundle。

## 决策

测试现在双向持有这条边界。spawn 改为运行 `pnpm run dev:web --skip-build`，任何阶段都完全碰不到产物与 record；同时在录制好的客户端构建环境之上显式传 `NODE_ENV=production`，为将来仍可能读取该环境变量的路径加一层防护。`.dsh-build/client-build-environment.json` 与 bundle、`dist` 的备份放在一起，并在同一个 `finally` 中恢复。teardown 顺序反转：`stopTree(watcher)` 先于 `writeFile(sourcePath, originalSource)` 执行，这样任何存活的 watcher 都无法观察到恢复动作，也就不会排进一个在产物恢复之后才完成的 emit。

## 备选方案

- **让 build 阶段照跑，事后恢复 record** —— 字节层面仍然正确，但该阶段让测试多花数秒去产出一批随即被丢弃的产物；跳过它严格更优，并且在源头消除了 NODE_ENV 隐患，而不是事后过滤。
- **先恢复源文件，依赖 `stopTree` 杀掉已排队的重建** —— `stopTree` 能终止它 spawn 的进程树，但已经派发的重建可能在产物恢复之后才完成写入；先停止 watcher 是移除触发源，而不是与其后果赛跑。
- **teardown 时用 `writeClientBuildRecord` 重算 record** —— 会把测试后目录树当时恰好持有的摘要烘进 record，包括残留损坏；恢复记住的字节能让失败保持可见，而不是把它规范化掉。

## 后果

record 消费者现在可以信任：测试前校验过的摘要在测试后仍然描述同一棵目录树。测试省掉了整整一次 `build:artifacts` 的开销。今后任何在 lane 已构建产物旁启动 `dev:web` 的测试都要遵守这条契约：跳过 build 阶段或接管 record，控制 spawn 的环境，并在触碰 watcher 监听的文件之前先停掉它。`--skip-build` 正是为带着现成产物到来的调用方准备的；在这里使用它让 `dev:web` 对人类用户的默认行为（总是重建）保持不变。
