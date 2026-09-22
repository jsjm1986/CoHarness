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

<a id="runtime-contract"></a>
## 运行时约定

输入传输通过 `stamp` 登记精确的人工消息，通过 `answer` 认领待回答问题的答案。用于展示的参与者字段和浏览器自报角色不能证明执行身份。提供者在替换输入时保留先前的编辑者。

委派在异步创建前捕获真正发起操作的 Agent。`captureSession` 为显式分叉读取实时或冷态来源的完整授权资料，不受所选转录前缀限制。`inherit` 将限制记录在子会话自己的日志中；`relay` 在相邻投递及其重试中保留发送方的限制。Session 访问检查和问题身份验证仍由传输负责。

`authorize` 为请求的能力检查执行 Agent 及其当前权限。`authorizeSelection` 在提交前检查显式特权预设选择。已捕获的范围、持久化事件或普通工具审批都不能替代这两类检查。取消仍由操作拥有，并传入异步授权和投递。

读取时必需的 `gateway/execution` 事件保留已接受的参与者事实和委派限制。不理解该事件的读取器必须拒绝日志，不能省略其中的限制。生成元数据可以携带已验证输入引用和一个主要计费参与者；其计费用途由 [Auto 审查归因](../../../.agents/notes/implemented/bug-fix/2026-09-22-auto-review-execution-attribution.zh.md) 负责。

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
