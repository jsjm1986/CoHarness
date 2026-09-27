---
description: "为受管输入、委派、恢复和特权操作保留已验证的执行参与者。新增必须保留人工授权的传输或消费者时阅读本页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-execution-authority

[English](README.md) | 中文

## 概述

在 Session 及其委派工作中传递已验证的人工输入身份，并在执行前检查当前权限。输入引用保留谁参与了工作，但不会授予权限。消费者通过同一服务处理实时输入、恢复工作和特权操作，无需依赖 Gateway 的传输细节。

## 目录

- [使用本包](#use-this-package)
- [运行时约定](#runtime-contract)
- [不变量](#invariants)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

输入与执行消费者导入本服务定义；受管部署组合 [Gateway Execution](../gateway-execution/README.zh.md) 作为提供者。定义本身没有配置，也不提供授权。独立本机 profile 不组合 Gateway 提供者。

`executionAuthorityOf(ctx)` 返回可用提供者。当所属应用声明 `executionAuthorityRequired` 时，提供者缺失会抛出 `execution/forbidden`；消费者不能将受管提供者缺失解释为本机权限。

`sameExecutionAuthority(current, captured)` 在异步授权后比较底层 Cordis 提供方。调用仍使用带追踪的提供方；新建追踪代理不代表提供方发生变化。移除和替换仍会使已取得的授权失效。

<a id="runtime-contract"></a>
## 运行时约定

输入传输通过 `stamp` 登记精确的人工消息，通过 `answer` 认领待回答问题的答案。用于展示的参与者字段和浏览器自报角色不能证明执行身份。提供者在替换输入时保留先前的编辑者。

委派在异步创建前捕获真实发起 Agent。`runCaptured` 将延迟回调绑定到该范围，`runRequest` 在传输查找完成后证明当前人类命令的来源，并保留已有捕获操作或子任务继承。只有新的根命令创建独立范围。`captureSession` 读取来源会话的当前执行，不受所选历史前缀影响。`inherit` 记录子任务来源，`relay` 将相邻 Agent 或同会话后台任务的结果带入接收操作。问题回答指定问题打开时捕获的范围。传输仍负责会话访问检查和问题身份验证。

`authorize` 核验确切执行范围与当前权限。工具派发前的守卫传入注册表颁发的执行令牌，使嵌套 PTC 调用在其他包装器运行前也保留父调用身份。`authorizeSelection` 核验当前选择者，但不更改执行身份。执行范围、持久事件或普通审批都不是权限授权。操作取消在核验与投递期间始终有效。

读取时必需的 `gateway/execution` 事件保留已接受的参与者事实和委派限制。保存或传出新式执行范围前，其 Session 记录 `gateway/scoped-execution`；不支持范围授权的读取者必须拒绝该日志。缺少此准入标记的执行范围状态无效。`gateway/continuation` 独立记录自动执行的来源。不含范围引用的旧记录仍可读取；这些事件词表扩展不改变 Session 结构格式。生成元数据可以携带已验证输入引用和一个主要计费参与者；其计费用途由 [Auto 审查归因](../../../.agents/notes/implemented/bug-fix/2026-09-22-auto-review-execution-attribution.zh.md) 负责。

<a id="invariants"></a>
## 不变量

本包定义服务和持久类型，但不拥有可独立变化的状态，因此不发布不变量配套入口。提供者负责当前授权并验证持久化输入引用。

<a id="further-exploration"></a>
## 进一步阅读

- [已验证的执行参与者](../../../.agents/notes/implemented/architecture/2026-09-22-verified-execution-participants.zh.md) — 身份、委派和权限交集决策。
- [Gateway Runtime](../gateway-runtime/README.zh.md) — 签名请求身份和私有传输。
- [Agent 发起人范围](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.zh.md) — 在编排入口恢复真正的 Agent。

<a id="model-experience"></a>
## 模型体验

无直接影响；服务定义不添加提示词、工具 schema 或模型可见结果。

#### KV Cache 影响

无；身份引用和服务调用不会改变模型请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 消费者必须使用真正的操作拥有者和显式服务方法；导入类型不会认证调用者或委派权限。
- 捕获的继承资料是提供者验证时使用的限制性输入，不是可转移的凭据或权限授予。
- 接口不在操作系统层面隔离 Host 代码；部署隔离仍是独立要求。
