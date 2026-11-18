# Agent Note: Setup-window append durability

状态：已实现

[English](2026-11-16-setup-window-append-flush.md) | 中文

## 问题

rc.3 在 `setupAndPublish` 中把 `sessions.announce(session)` 提到 agent `setup` 之前。改动前 setup 在 Session 未发布时运行，append 落入 `appendUnstoredSuffix` 并同步到达持久化写句柄；改动后 setup 内 append 经 `session/event` 进入持久化 write-behind 队列（`maxDelayMs` 批写）。api-proxy 的空白会话 preset 采用——`composition.setup` 中的 `agent.session.append('agent-preset/selected', ...)`——是唯一承诺 durable-at-return 的调用方：复用的空白会话必须让随后的任何检查都能观察到采用结果。新次序下事件只在 live 日志而未冲刷，持久层检查与 write-behind 排空竞争，可能看不到选择记录。

## 决策

api-proxy 在 setup 窗口 append 之后等待官方耐久屏障 `ctx.sessions.flush(agent.session)`，在不回退上游 announce 次序的前提下恢复该操作的 durable-at-return 契约。append 仍是普通 `session/event`;flush 在 `resume`/`reuse` 返回前排空 write-behind 队列。

## 影响

- 空白会话 preset 复用在调用返回时即持久；remote/fixture 持久层检查能立即观察到 `agent-preset/selected`。
- 其他 setup 路径不 append 事件，flush 只作用于这一采用点；其余 write-behind 批写行为不变。

## 备选方案

- 把 append 移回 `sessions.announce` 之前——否决：会重新劈开本次同步有意统一的 rc.3 生命周期，且 `appendUnstoredSuffix` 是调用方不应依赖的内部接缝。
- 在 `inspect`/`inspectLive` 内排空——否决：读路径不得推进生产者状态；提交点冲刷属于写入方。

## 验证

- `apps/web/tests/blank-preset-reuse.e2e.ts`——重建后 `lib/` 上 4/4：复用返回后持久层检查立即观察到 `agent-preset/selected: 'standard'`,live 与存储组合一致。
