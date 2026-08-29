# Agent Note: 为子代理模型路由增加会话级授权

Status: implemented

[English](2026-08-29-subagent-model-selection.md) | 中文

## Problem

上游委派工具允许为子 Agent 请求不同的 provider 或 model。如果直接接受客户端字段，浏览器或不受信任的 provider 可能绕过项目模型治理。

## Decision

只有启用模型选择设置时，subagent 工具才接受 provider、model、reasoning effort 和输出 token 字段。设置服务校验非空且不重复的路由白名单。首次符合条件的请求会把白名单副本记录到 Session，之后使用该会话策略，因此设置刷新不会改变正在运行的会话。显式路由在创建子 Agent 前通过策略检查并交给实时 LLM 服务解析；不支持的 provider 在产生副作用前失败。明确声明 `agentOptions: false` 的 provider 会拒绝带选项的委派；未声明该能力的旧 provider 继续兼容继承路由。

## Alternatives considered

**信任客户端提交的 provider 和 model。** 不采用，因为客户端不是授权来源，可能选择未批准的凭据路由。

**每次创建子 Agent 都读取设置服务。** 不采用，因为会话期间策略变化会让回放和审计结果依赖时序。

**立即要求所有既有 provider 实现新能力。** 不采用，因为未声明负能力的旧 provider 可以安全地继续使用继承路由。

## Consequences

新部署可以提供受治理的路由选择和模型发现工具。Session 日志记录委派界面使用的策略，非法路由在创建子 Agent 前明确失败。白名单只包含路由；凭据和 provider 配置仍由 LLM 与 Gateway 层负责。

## Testing

模型选择单元测试覆盖白名单校验、继承、路由切换、reasoning effort 校验和 fail-closed 拒绝。Subagent 与 SDK 测试覆盖选项传递和旧 provider 行为。
