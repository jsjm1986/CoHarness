# Agent Note：原子化发布取消 fixture 的 pid 文件

状态：已实现

[English](2026-11-25-native-cancel-pid-file-atomic-publish.md) | 中文

## 问题

`packages/util/native-command/tests/failed-spawn.spec.ts` 在托管 Linux coverage lane 上失败，仅一个字段不匹配：`during-live` 场景记录了 `helperRunningAfterReturn: true` 而快照要求 `false`。产品契约不可能产生该结果——`runNativeCommand` 在 abort 时投递 SIGKILL，且仅在子进程 `close` 事件后 settle，这意味着调用方继续执行时 helper 已死亡并被回收。测量本身存在竞态：fixture helper 用 `writeFileSync` 发布 pid，open/write/close 序列期间文件已存在但仍为空。就绪 watcher 按存在性触发，主机争用下 fixture 可能读到空文件：`Number('')` 为 `0`，而 `process.kill(0, 0)` 在 POSIX 上探测的是调用方自己的进程组——永远存在——因此活性检查无论 helper 真实状态如何都报告 `true`。

## 决策

helper 现在把 pid 写入同级 `.tmp` 文件再 `renameSync` 到被观察路径，watcher 确认存在的路径因此只以完整状态出现。被测的取消契约——abort 时 SIGKILL、关闭后 settle——不变，返回后单次活性探针也不变；有了真实的正 pid，`close` 之后的 `ESRCH` 是真正的保证而非竞态。

## 备选方案

- **轮询 `process.kill(pid, 0)` 取代单次检查**——会让探针本身容忍抖动，但也重新引入真实竞态：正确的产品在回收后才 settle，任何观察到的活性都是测量损坏，轮询是用掩盖输入损坏代替排除它。
- **校验 `pid > 0` 并重读**——以更多活动部件收敛到同样结果；原子发布直接消除非法状态而非事后检测。
- **当作产品静止性回归处理**——被构造排除：settle 链在 `close` 之后，而 SIGKILL 后的 `close` 意味着进程已不存在。

## 后果

未来任何通过文件系统为跨进程测试发布小型控制值的 fixture 都必须把发布当作原子操作——先写后改名或等效的单次调用原语——因为目录 watcher 观察到的是存在性而非完成性。相关：[PTC 取消探针 yield](../testing/2026-11-25-ptc-cancel-probe-must-yield.zh.md) 覆盖 Windows lane 上的同类测试设计问题。
