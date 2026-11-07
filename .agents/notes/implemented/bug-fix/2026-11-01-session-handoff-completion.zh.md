# Agent Note: 会话交接要求模型提取完整结束

Status: implemented

[English](2026-11-01-session-handoff-completion.md) | 中文

## Problem

提供方可以先输出文本，再报告错误、取消、输出 token 耗尽或工具调用。会话交接会把这些残缺文本当作模型 capsule。没有任何结束状态就结束的迭代器也会被接受。续接者因此可能收到不完整的状态，而非可用的本地历史。

## Decision

提取保留最终结束原因，仅在 `stop` 后接受非空文本。其他结束原因或缺失结束状态都返回已授权的本地尾部。调用方取消与配置的交接截止时间仍向上传播，不会转换成成功回退。提取完成后、披露任一简报前，继续复核跨会话可读性。

## Alternatives considered

**接受任意非空模型输出。** 残缺 capsule 可能省略工具承诺提供的状态与下一步。

**自动重试提取。** 工具已有可用的本地历史回退；额外推理增加成本和延迟，也不能证明首个输出完整。

## Consequences

工具 schema、路由、权限、模型准入与 Session 格式保持现有行为。新失败提取返回本地简报。已经记录的工具结果保持原样。[交接功能](../feature/2026-10-18-session-handoff-tool.zh.md) 继续定义投影与预算。

## Verification

包测试拒绝各个受支持的非正常结束原因以及缺失结束状态下的残缺文本。实际 TypeScript 与 Python SDK 组合针对这五种中断和正常结束运行真实查询工具、SQLite 历史、Agent 循环及 LlmRuntime，并将返回简报与同一 golden 比较。私有原始源码包与构建包在中断场景返回残缺 capsule，正常结束结果保持一致。
