# Agent Note: 恢复路径在读取日志前先经 load 提交冷恢复

Status: implemented

[English](2026-10-16-resume-load-before-closers.md) | 中文

## 问题

`AgentLoop.resumeWith` 此前自行修复中断的尾部轮次：打开写句柄、读取已存日志、合成 `interruptedTurnClosers`，再经该句柄追加。在使用协调器的后端上，这条序列会把同一次恢复执行两遍。`open` 经由 `inspect` 完成，而 `inspect` 会保留一个就绪准备项，其内存视图已经携带同一组确定性 closer。接下来对该 id 的 `append` 会触发会话接管：`commitPrepared` 发现存在待提交的 closer，便先经 `commitRepair` 将其落库，然后才校验调用方批次，于是调用方携带的同一组 closer 撞上了已经推进的游标——`append seq mismatch: expected N, got N-1`。已存日志是否留下未闭合轮次取决于时序，因此该碰撞虽然在任何平台都成立，却只以 Windows 独有的 CI 失败出现在 Agent Teams 重启测试中。

## 决策

`resumeWith` 在取得写所有权之后、读取日志之前等待 `persistence.load(id)`。`load` 是带提交义务的冷恢复契约：使用协调器的后端会预留准备源、恰好提交一次撕裂尾部截断和中断轮次 closer、丢弃预留，并返回配平视图。随后的写句柄读取因此观察到已完成修复的持久日志，`interruptedTurnClosers` 产出空批次，不再发起第二次修复。`load` 仍为基于 `inspect` 的抽象默认实现的后端原样返回未修复日志，closer 追加路径在那些后端上照旧运行。写所有权仍在最先取得，使同 id 的并发恢复继续被拒绝，且该调用运行在既有的中止融合包裹之内。

## 考虑过的替代方案

**在协调器的 append 内对 closer 批次去重。** 不采用：append 只承担连续序列校验这一项义务，静默吸收陈旧重复批次会掩盖真实的双写竞争，而不是报告它。

**让恢复改走 `persistence.prepare()`。** `prepare` 返回的是协调器预留的 Session 作为发布单元，但恢复路径要为实时会话的持久化通道保留写句柄，并以句柄的 `eventState` 作为 `SessionStore.prepare` 的种子；那会重接发布边界，而不是恢复顺序。

**移除协调器在接管时的修复。** 不采用：首次写入接管未知状态时仍必须结清待提交的修复，否则其它写入路径会观察到未修复的游标。

## 后果

在使用协调器的后端上，对未闭合轮次会话的恢复恰好提交一次修复，Agent Teams 持久化测试在 Windows 上遇到的 `append seq mismatch` 随之消除。每次恢复在同一条按 id 串行化的通道上多承担一次 `load` 往返，该通道同时也是修复本身使用的通道。`resume.spec.ts` 固定了 `load` 先于写句柄读取的顺序，以及已存修复只落库一次；Agent Teams 重启套件在两种后端上覆盖端到端路径。本项消费的准备/检查/加载机制仍由 [Session 准备笔记](../architecture/2026-08-05-session-preparation.zh.md)持有。
