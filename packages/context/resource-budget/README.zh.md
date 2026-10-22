---
description: "模型请求与受管进程的执行资源准入及静止后释放义务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-resource-budget

[English](README.md) | 中文

## 概述

执行消费者需要在启动工作前预留模型或进程容量时，使用此定义。具体提供方负责准入与调度；此包不提供调度器或部署配额。消费者保留预留，直到执行停止；取消或传输失败导致清理结果不确定时，也继续保留。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

消费者从包根导入 Service Definition，并从 `@deepseek-ai/dsh-resource-budget/types` 导入请求类型。组合需要具体的 `ResourceBudget` 提供方；挂载此抽象定义不会实现准入。此定义没有配置字段。

启动资源前先预留容量。取消成功本身不能证明进程、模型请求或其清理已经停止。只有证明静止后才释放；清理结果不确定时进行报告，预留仍保持占用。最终记账决定由提供方确认。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[`src/index.ts`](src/index.ts) 声明 `ctx.resourceBudget`；[`src/types.ts`](src/types.ts) 声明调用方元数据和释放义务。已验证的操作者与项目归属由具体提供方负责，而非由调用方提交身份字段。[子系统参考](../../../docs/subsystems/resource-budget.zh.md) 负责类型与生成的服务 API。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [资源准入参考](../../../docs/subsystems/resource-budget.zh.md)——资源种类和预留生命周期。
- [Execution Authority](../execution-authority/README.zh.md)——已验证的执行身份与权限。
- [Gateway](../../../gateway/README.zh.md)——受管部署和节点配置。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此定义不贡献提示词、工具 schema 或模型可见结果。

#### KV Cache 影响

无；资源准入不构造模型请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 具体提供方与执行消费者必须实现调度和预留所有权；导入此包不会施加容量限制。
- 声明的资源种类覆盖模型和进程，工作线程没有独立资源种类。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
