# Agent Note：持久化句柄跟随 Agent 生命周期所有权

状态：已实现

[English](2026-09-06-session-handle-agent-lifecycle.md) | 中文

## 问题

持久化服务原本只有耐久化操作，没有明确的 Session 写入者所有权。因此恢复或创建流程可能完成准备，却没有生命周期对象说明谁可以追加，以及所有权何时结束。

## 决策

`SessionPersistence` 提供读句柄和写句柄。每个持久化实例对同一个 Session id 只允许一个写句柄；读句柄彼此独立，并且读句柄拒绝追加。对于新的持久化 Session，`AgentFactory.createAgent` 在发布前取得写句柄；`resume` 在准备完成后打开写句柄。句柄由同一个幂等的 Agent 销毁流程关闭，该流程负责排空循环并注销 Session。配置驱动的恢复或创建也走同一条路径；同步的内存 `agentLoop.create` 保持不变。

抽象所有权是进程内的，并叠加在协调器现有的按 id 串行化之上。JSONL 现在通过 `openHandleAsync` 增加 root 级原子 lock 文件；Gateway 和 SQLite 仍保留各自 provider 的事务所有权。v2 磁盘迁移使用这个所有权接缝，而不是 provider 专属的兼容层。

## 考虑过的替代方案

**继续把所有权隐含在 `session/created` 监听器中。** 拒绝，因为监听器只能观察生命周期，无法识别未来写入的调用方，也无法在发布前拒绝第二个写入者。

**让同步便利入口 `agentLoop.create` 等待持久化。** 本阶段拒绝，因为大量组装测试和内存示例依赖其同步约定；异步 AgentFactory 已经是消费者使用的持久化入口。

**立即为每个 backend 增加独立锁协议。** 作为公共 API 约定拒绝；provider 可以在 `openHandleAsync` 后增加自己的原子锁，但生命周期接缝保持共享，锁恢复策略由 provider 自己负责。

## 结果

持久化 Agent 创建现在会在发布前发现已有写入者并失败，成功销毁后 id 可以再次使用。JSONL 通过原子 lock 文件拒绝第二个进程，并在记录的 PID 已不再存活时移除锁；无法读取或仍存活的锁会继续阻塞。自动 v2 转换仍是 provider 后续工作。脱离 Agent 的读消费者可以使用同一服务而无需取得修改权限，句柄继续委托现有协调器保证耐久性。

## 验证

Agent-loop 生命周期测试覆盖句柄取得、第二个写入者的拒绝以及 `AgentHandle.dispose()` 后的释放。Session persistence 和 JSONL 测试覆盖只读拒绝、幂等关闭、进程内所有权、存活与死亡进程锁和释放。
