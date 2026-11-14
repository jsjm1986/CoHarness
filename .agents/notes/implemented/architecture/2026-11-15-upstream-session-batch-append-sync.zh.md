# Agent Note：上游 Session 批量 append 同步

状态：已实现

[English](2026-11-15-upstream-session-batch-append-sync.md) | 中文

## 问题

上游 v0.2.2-rc.3 扩展了 `Session.append`，使其接受位置化事件输入数组，在发布之前原子地提交全部成员。本地 Session 每次调用只能追加一个事件，且其 `appendAdmissions` 预留协议与 `session/created` announce 守卫是本地生命周期分歧，上游的批量路径并不知道它们。

## 决策

- `Session.append(inputs: readonly SessionEventInput[])` 先校验全部候选与分发——快照、`assertSupportedRequestHeader`、规范化载荷校验、每个已注册的 append admission、以及在隔离 fold 上的 `surfaceManager.prepareBatch`——然后推入全部成员、采纳已验证的 surface 并按序发布。`session.currentBatchPublication` 标识正在投递的成员；第一个观察者运行时 `session.seq` 与 `session.surface` 已包含完整批次。
- Append admissions 在任何提交之前按成员运行；拒绝或后续的校验失败按逆序回滚成功的预留，因此被拒绝的批次既不预留也不追加。
- `planSurfaceEvent` 增加可选的 `candidates` 上下文，通过跨越 `[...log, ...candidates]` 的 `read(seq)` 闭包解析被引用的序号，因此批次成员可以引用同一批次中更早的成员（developer header、替换的 `sourceEventSeqs`、tool-result 重写）；慢速路径在克隆状态上折叠批次内部影响。
- 单事件 append 保持签名不变并复用共享的 `snapshotAppend`/`createAppendEvent` helper；重入、announcement、detach 与 `session/created` 守卫不变。

## 后果

- 使用批量 append 的上游调用方原样可用；按上游契约编写的监听器可以依赖 `currentBatchPublication` 与首次观测时的完整日志。
- 批量准入失败与单事件 append 一样是全有或全无。
- 批次成员可以合法引用彼此的 seq，这是单事件 append 调用方永远无法表达的。

## 已考虑的替代方案

- 只在批次粒度移植 `appendAdmissions`（一个预留覆盖整个数组）—— 被否决：admissions 按候选资源预留，按成员回滚本就可干净组合。
- 保留上游不带 `announcement !== 'dispatching'` 守卫的 detach—— 被否决：本地 announcement 四态使 dispatch 期间的 detach 非法；批量路径保留本地守卫。

## 验证

- `packages/core/session/tests/append.spec.ts`（上游套件加一个本地准入回滚用例）：14 个测试——稀疏数组、选项处理、同批替换、getter 重入、分发否决、最后发布后 detach、准入回滚。
- session 与 session-persistence 套件：3618 个测试通过；agent-loop resume、request-reconstruction 与 apiproxy fork 套件全绿。
- `gen-cordis-catalog` 重生成 `session/event` 文档；包 README 双语对与 `verify-translation-pairing` 已重录。
