# Agent Note: 可继续 child 接受带作用域捕获的 outputSchema

Status: implemented

[English](2026-10-13-continuable-structured-output.md) | 中文

## 问题

`ContinuableStartSpec.request` 省略了 `outputSchema`，因此模型可以委派可继续的 child，却无法要求其最终结构化结果。结算通知同样只携带停止原因与 closing text：已提交的结构化值或提供方诊断无法经 Activation 路径送达父级。上游来源：`3d852a1cea5`、`6f0174b5a2b`、`a1da7bcfb96`，均仅存在于 alpha.2。

## 决策

`ContinuableStartSpec.request` 只省略 `label` 与 `signal`。`SubagentRuntime.startContinuable` 在物化之前运行与一次性 `start` 相同的能力检查（`assertCapabilities` 加 `assertObjectJsonSchema`），因此不具备 `outputSchema` 的提供方会在任何 child 身份被预留之前被拒绝。

作用域结构化运行时迁入 subagent 包的 `src/structured.ts` 并导出供同进程提供方兄弟包使用；in-process driver 改为导入它而非保留私有副本，并继续为既有消费方转出 `STRUCTURED_OUTPUT_TOOL`/`STRUCTURED_OUTPUT_INSTRUCTION`。`attachStructuredRuntime` 接受 `canComplete` 谓词，决定合法的工具调用能否暂存其捕获。

请求携带 `outputSchema` 时物化会附加该运行时；闭包要求 child 的 `nextStep`/`nextTurn` 队列为空且 child 不拥有未结算的直接可继续工作。由于 `waitForChildren` 是异步的、工具执行内无法 await，注册表通过 `hasPendingDirectChildren(parent)` 同步回答：记录谱系中包含该父级的在途物化，或以该父级为 `parentSession` 的驻留 Activation。`SubagentRuntime` 仅通过符号键化的 `subagentPendingDirectChildren` 内部面（`internal.ts`）暴露它，因此公开 Service Definition 不会为单一消费方增加探针操作。

`SubagentInbox.deliver` 在 attachment 报告 `acceptsInput() === false` 期间以 `INPUT_CLOSED` 拒绝一切子向投递：从捕获暂存到权威 `tools/result` 裁决为止（含外层 PTC 执行）。失败的结果会丢弃暂存捕获并重新开放输入；已提交一次的合法调用不可重开也不可被取代。

`ActivationTerminal` 在 `output` 之外携带可选的 `structured` 与 `diagnostic`。观察者的 `capture(child, structured)` 读取已提交的值，并把没有已提交捕获的 `completed` epoch 降级为 `error`。结算通知追加 `Structured result: <JSON>`，随后是诊断文本，两者都独立于 closing text。本地可继续 child 是管理器持有的同进程 Agent，此路径上没有提供方产出诊断；该字段使终止词汇表能够携带诊断，方式与一次性及进程外运行相同。

持久化描述符仍省略 `outputSchema`——它预算的是单次激活的结果约定而非持久化 child 组合配置——因此冷恢复的 epoch 不接受结构化结果。

## 考虑过的替代方案

**结算时异步解析后代。** 已否决：`waitForChildren` 无法在必须裁定接纳的工具执行内运行；同步注册表探针在不扩大公开服务面的前提下回答同一驻留问题。

**在可继续启动上拒绝 `outputSchema`。** 已否决：上游在标准能力门下接纳它，且作用域运行时已约束一次性 child；复制一份更弱的可继续变体会留下两份需要维护的捕获约定。

## 影响

委派模型可以要求可继续 child 提供与一次性运行相同 schema 约定的结构化结果。合法调用一旦暂存，child 不再接收输入；自身工作未结算时无法提交；缺少捕获会使该 epoch 失败而非静默按 `completed` 结算。冷恢复的 epoch 不会报告结构化输出，因为没有 schema 跨恢复存活。

## 验证

`packages/subagent/subagent/tests/continuation.spec.ts` 覆盖：已提交捕获进入结算通知、缺少捕获按 `error` 结算、暂存期间 `INPUT_CLOSED`、暂存前已接纳的排队输入先被消费、以及自有后代在释放前阻止提交。`continuation-messages.spec.ts` 覆盖序列化结果与诊断块独立于 closing text。`internal.spec.ts` 覆盖探针原样转发精确存活父级。`packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` 继续经 driver 转出出口覆盖共享运行时。

## 相关

- [可继续的后台子 agent](2026-07-21-continuable-background-subagents.zh.md)——持有 schema 省略所属的 Activation/描述符约定。
- [子 agent 能力缝隙](2026-06-21-subagent-capability-seam.zh.md)——持有 `startContinuable` 现在共享的静态能力门。
- [产品子 agent 故障事实](2026-08-18-product-subagent-failure-facts.zh.md)——持有 `ActivationTerminal.diagnostic` 可携带的有界诊断词汇。
