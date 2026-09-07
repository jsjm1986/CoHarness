# Agent Note：持久化句柄跟随 Agent 生命周期所有权

状态：已实现

[English](2026-09-06-session-handle-agent-lifecycle.md) | 中文

## 问题

持久化服务原本只有耐久化操作，没有明确的 Session 写入者所有权。因此恢复或创建流程可能完成准备，却没有生命周期对象说明谁可以追加，以及所有权何时结束。

## 决策

`SessionPersistence` 提供读句柄和写句柄。每个持久化实例对同一个 Session id 只允许一个写句柄；读句柄彼此独立，并且读句柄拒绝追加。对于新的持久化 Session，`AgentFactory.createAgent` 在发布前取得写句柄；`resume` 会在读取或修复存储 Session 之前打开写句柄。句柄会在 registry 脱离之前由同一个幂等的 Agent 销毁流程关闭，该流程负责排空循环、释放持久化所有权并注销 Session。配置驱动的恢复或创建也走同一条路径；同步的内存 `agentLoop.create` 保持不变。

当前所有权是进程内的，并叠加在协调器现有的按 id 串行化之上。JSONL provider 还会在写句柄整个生命周期内持有 root 原子锁；SQLite 和 Gateway provider 保留各自的 provider 所有权规则。格式迁移使用同一生命周期接缝，并且不会在没有写所有权时运行。

## 考虑过的替代方案

**继续把所有权隐含在 `session/created` 监听器中。** 拒绝，因为监听器只能观察生命周期，无法识别未来写入的调用方，也无法在发布前拒绝第二个写入者。

**让同步便利入口 `agentLoop.create` 等待持久化。** 本阶段拒绝，因为大量组装测试和内存示例依赖其同步约定；异步 AgentFactory 已经是消费者使用的持久化入口。

**立即为每个 backend 增加独立锁协议。** 拒绝，因为在格式迁移定义锁恢复、陈旧所有者处理和 provider 原子性之前，这会重复生命周期接缝。

## 结果

持久化 Agent 的创建和恢复现在会在发布前发现已有写入者并失败，成功销毁后 id 可以再次使用。在 registry 脱离前关闭句柄，避免配置替换与前一个生命周期的最终持久化排空发生竞态。脱离 Agent 的读消费者可以使用同一服务而无需取得修改权限。JSONL resume 和 provider migration 会保留源 generation，同时发布当前格式。

## 验证

Agent-loop 生命周期测试覆盖恢复读取前取得句柄、第二个写入者的拒绝、先关闭句柄再脱离 registry、被放弃的 open，以及 `AgentHandle.dispose()` 后的释放。Session persistence 句柄测试覆盖只读拒绝、幂等关闭和进程内所有权；JSONL 测试覆盖跨进程锁和旧 generation 发布。
