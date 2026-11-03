---
kind: upgrade-guide
description: "受管外部推理要求逐请求父级控制与受支持的模型路由。"
---

# 受管运行时中的外部子代理

[English](guide.md) | 中文

## 变更

父级模型授权或资源准入生效时，不透明 Claude Code 和 ACP 执行返回 `UNSUPPORTED_CAPABILITY`。本地与 SSH 一次性 Codex 及持久成员为每次原生请求使用已注册的发起 Agent 的 Responses 适配器。上游凭据保留在父级，原生 WebSocket 推理与内部请求重试被禁用。独立组合保留原生认证。 无效请求 JSON 仍返回 `400 INVALID_REQUEST`；意外的父级失败使用 `502 SERVER`。必需的 Session flush 失败会在上游派发前阻止推理。

ACP 和 Claude Code 成员路由属于编排。不受支持的受管轮次在模型准入前拒绝执行，模型预算耗尽不会推迟拒绝。缺少必需模型策略仍返回 `MODEL_POLICY_UNAVAILABLE`。

Codex 模型请求添加必读的 `subagent/codex-model-request` 事件。不认识该事件的读取器会拒绝日志。已提交的 Session 代次保持不可变；该事件不改变结构格式版本，也不提供降级支持。

## 迁移

1. 对 Codex，配置 [`modelProvider` 和 `model`](../../../../packages/subagent/subagent-codex/README.zh.md#configuration)，指定已注册的父级 `openai-responses` 路由。若父级选定路由支持此操作，受管运行也可以继承该路由。上游凭据留在父级提供方，移除显式子级 API key。
2. 对 SSH Codex，在 Session 目标部署 `remoteCommand`，并允许遵守请求回环绑定的远端 TCP 转发（`GatewayPorts no` 或 `clientspecified`）。使用实际 Agent 的 standing SSH 连接；缺少连接或转发失败时拒绝启动。SSH 和 Codex 提供方一同升级。自定义 `PresetMount` 记录须提供实际 standing `environment` fiber。
3. 把不支持的 Claude Code 或 ACP 提供方替换为进程内或[受管 SDK 提供方](../../../../packages/subagent/subagent-dsh-sdk/README.zh.md)。更改提供方不会迁移原生对话历史。
4. 运行包含两个原生模型请求的委派任务。确认分别获取父级额度，且用量归属发起 Session；验证在第二次排队期间撤权会阻止其上游 HTTP。保持必需的授权与资源服务启用。
5. 对没有捕获模型选择的旧绑定新建持久成员。保留旧原生历史，不向其赋予新的上游权限。新成员跨父级设置变化和冷恢复保留选定上游；外层编排不额外计作模型请求。验证通过同一提供方实例再次委派：省略的模型设置继承成员已保存的上游。
6. 对话检查点、回放和标题观察器除 `llm/stream` 外也订阅 `llm/orchestration`。授权与模型计量仍针对实际模型请求；外部轮次不额外计作推理。
7. 对包含受管 Codex 推理的 Session，使用认识新事件的读取器，并保留每个已提交代次。

8. 使用 `modelRequestTimeoutMs` 配置原生 HTTP 请求体接收时限。验证不完整的已认证上传返回 `504 TIMEOUT`，不创建模型请求事件或许可，并为后续完整请求保留容量。
