# Agent Note: 将主请求限定到其存活的 LLM 服务

Status: implemented

[English](2026-11-02-scoped-model-request-origin.md) | 中文

## 问题

独立 Runtime 树可以在同一进程中复用 Session id 与模型路由。进程全局的请求标记会让其他树的请求消耗本树的待决标题修订。假定人工输入先于 `step/start` 的标题触发条件也会遗漏真实循环输入，因为输入在该事件之后进入日志。

## 决策

每个 `LlmRuntime` 持有循环构建请求的精确对象弱集合。标记方法接受已冻结对象且不修改它；副本与其他服务实例不会继承归属。服务释放时丢弃集合并拒绝新增标记。派发请求的循环服务记录归属，全局 LLM waterfall 监听器通过发出事件的服务接收者检查，包括隔离的提供方。

自动标题工作要求当前步骤仍打开、请求路由与日志一致，且带标记请求包含待处理人工消息的 id。请求成员关系支持在步骤之前或步骤内记录输入，并排除延迟到达的旧请求。标记不授予执行、账号或计费权限。

[可重建请求决策](../architecture/2026-07-05-reconstructable-requests.zh.md)继续负责模型输入的日志要求。[冻结缓存决策](../simplification/2026-09-06-agent-request-freeze-evidence.zh.md)继续负责成功冻结消息的证据；两者的决策理由均未被取代。

## 考虑过的替代方案

**保留进程全局归属或比较 Session id。** 两者都无法区分共享进程与 id 的独立服务所有者。

**在请求上添加标记。** 循环请求已冻结。可复制或序列化字段也不具有精确对象和存活所有者的语义。

**使用监听器创建时的上下文。** 全局监听器可以观察隔离的 LLM 提供方；请求归属于发出事件的服务。

**比较输入与步骤开始的序号。** 真实循环输入在步骤内进入日志。序号顺序无法证明请求包含待处理消息。

## 影响

使用方调用[服务方法](../../../../packages/llm/llm/README.zh.md#understand-the-implementation)，外部调用方遵循[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/model-resource-ownership/guide.zh.md)。弱引用不会保留旧历史。Session 事件、格式和 SDK 协议字段保持不变。

[可运行的 Loader 组合](../../../../examples/headless-agent/tests/fixtures/interaction/request-origin/cordis.yml)检查共享 Session id 的两个真实循环、其他服务的请求、不变请求头、冻结对象、副本和服务撤回。提供方测试覆盖隔离服务、两种输入顺序和延迟旧请求。这些本地提供方无需真实模型 API。
