---
kind: upgrade-guide
description: "模型请求保留资源归属和不同的准入失败 code。"
---

# 处理模型资源归属与准入失败

[English](guide.md) | 中文

## 变更

物理模型流保留中间件开始前的资源提供者。预备、准入、授权或凭据解析期间撤销或替换提供者，流会在派发 HTTP 前以 `RESOURCE_BUDGET_UNAVAILABLE` 结束。延迟授予的许可归还原提供者。旧请求不能从替代提供者取得容量，移除受管要求也不能让已捕获的受管请求变为独立执行。

此规则适用于受管组合和已安装资源提供者的独立组合中的普通及预备模型操作。从未要求或安装资源准入的独立调用仍受支持。编排轮次不预留模型容量；每个嵌套模型请求分别使用当前提供者。设置和持久化数据无需改写。

资源准入失败保留类别：服务不可用使用 `RESOURCE_BUDGET_UNAVAILABLE`，取消使用 `ABORTED` 和 aborted 结束，排队过期使用 `RESOURCE_ADMISSION_EXPIRED`，拒绝使用 `RESOURCE_ADMISSION_REFUSED`。这些本地失败不添加提供方 HTTP 状态，也不改变默认重试策略。已校验的详细失败事实优先。

治理插件还会在准入流时保留执行权威、Agent 与计费见证。替换该服务，或改变计费输入集合、主要发起人，会以 `MODEL_EXECUTION_IDENTITY_FAILED` 拒绝待执行的物理请求。移除可选权威不能将受管工作转为独立调用。新流使用当前授权；失败的旧流保留原归因。模型策略、用量和 Session 格式均不变。

基础设施模型请求保留 Runtime 准入和默认未归属活动。跟踪 Session 或环境 Agent 不会把其成本归因到后续执行的发起人。现有显式 `executionIdentity` 继续受支持；确实需要归属基础设施活动的调用方应显式提供该证明及 Session。项目／个人计费所有者、模型策略检查和普通执行冲突检查保持现有行为。请以匹配 Runtime 重建治理插件。历史用量保留原上报结果；本变更不增加策略、用量或 Session 格式。

主请求标记由每个 `LlmRuntime` 分别持有。独立导出的 `markAgentLoopRequest` 和 `isAgentLoopRequest` 改为 `ctx.llm` 上的同名方法。精确的冻结请求仅由存活的归属服务识别；通过已撤回服务标记请求会抛出 `MODEL_REQUEST_ORIGIN_UNAVAILABLE`。全局 LLM waterfall 监听器通过发出事件的 `this: LlmRuntime` 接收者检查归属。

## 迁移

1. 将更新后的 `@deepseek-ai/dsh-llm` 产物与匹配的 Runtime 载荷一起部署。提供者启动仍遵循[受管资源注册流程](../managed-resource-admission/guide.zh.md)。
2. 如果应用在运行期间替换 `resourceBudget`，处理 `RESOURCE_BUDGET_UNAVAILABLE`，并在恢复提供者后构造新的流。不要复用仅能执行一次的预备操作。
3. 确认在旧提供者上排队的请求不会在替换后发送 HTTP，延迟授予的许可归还旧提供者，新请求使用替代提供者。参见 [LLM 参考](../../../../packages/llm/llm/README.zh.md)。
4. 按 code 路由资源准入结果。将 `ABORTED` 作为取消处理；保留过期与拒绝两个独立类别，不将其解释为上游限流。
5. 重新构建并部署匹配的 `dsh-model-governance` 插件。验证自动压缩等待期间替换执行权威：过期摘要既不派发也不提交，原用量归因保留，许可释放，后续模型调用可以使用新权威。
6. 将直接使用标记函数的代码改为调用归属服务的方法，并重建匹配的 LLM、AgentLoop 与 session-title 产物。验证其他服务的请求不影响待决标题，普通循环请求仍能生成标题。无需迁移 Session 或 SDK 协议。
