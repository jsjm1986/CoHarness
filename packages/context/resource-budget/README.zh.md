---
description: "节点级执行准入提供方与消费方的资源许可义务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-resource-budget

[English](README.md) | 中文

## 概述

在启动模型请求或进程前申请许可，并在执行停止前保留其占用记录。本包声明服务接口；组合中的提供方必须实现准入。托管 Gateway 组合提供该 provider；LLM adapter 派发、已注册的原生 Messages 搜索和子进程分配会申请其许可。

## 目录

- [许可所有权](#permit-ownership)
- [远程协调](#remote-coordination)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="permit-ownership"></a>
## 许可所有权

抽象 `ResourceBudget` 服务提供 `acquire(request)`。请求指定 `model` 或 `process`，并可携带取消信号和执行中的 Session id。提供方解析已验证的操作者与项目，不接受消费方提交这些身份。

组合必须挂载具体提供方；直接挂载此抽象定义会在构造时失败。

提供方为每个操作分配独立的 `ResourceOperationId`，并在重试时保留。仅有有序注册序号，无法在提供方替换后区分重试和另一个操作。

消费方先等待准入，监听许可的取消 `signal`，并在确认静止后等待 `release()`，无法确认清理时等待 `uncertain()`。不确定状态保留占用以及许可与调用方、提供方之间的取消关联，之后仍可报告精确完成。请求通过 `origin` 选择捕获的执行、签名交互调用者或 Runtime 基础设施；这些元数据不进入模型输入。部署限制与调度由提供方负责。

<a id="remote-coordination"></a>
## 远程协调

`./wire` 入口校验操作引用、来源、资源状态、完成报告和已提交的节点策略。UUID 在比较前规范化。请求只能携带 Session／scope 引用、签名 principal 或明确的 Runtime 基础设施来源，禁止指定操作者和项目编号。每批轮询最多包含 512 个精确操作引用，HTTP 消息不超过 64 KiB。

Gateway 在 `/internal/runtime/resources/` 下实现已鉴权的注册、请求、批量状态与完成接口。注册返回已提交的策略，不清除既有任务。账户权限撤销或 Runtime 停止期间，只有精确的完成接口接受当前 bearer；其他接口仍使用普通 Runtime 认证。supervisor 确认进程范围停止后，只回收句柄捕获代次的资源，即使实例行已推进至更新代次。状态读取在排队派发前，按已保存的来源重新检查当前权限；带执行范围的 Session 不能省略该范围。[Gateway 提供方](../gateway-runtime/README.zh.md#resource-admission)负责 Runtime 注册与传输。

<a id="model-experience"></a>
## 模型体验

没有直接影响；`ResourceBudget` 接口不声明 prompt section、工具 schema 或模型可见结果。

#### KV Cache 影响

无；服务调用不改变模型请求内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 准入覆盖实际 LLM 派发与 subprocess 服务。绕过这些服务直接分配 worker 或进程的入口需要各自的消费方；导入本定义不能约束这些入口。
- 托管 Runtime 进程限制是另一项已实现的机制；参见 [Runtime 准入](../../../gateway/README.zh.md#performance-and-runtime-admission)。

<a id="dev-note"></a>
### 开发备注

无。
