# Agent Note：外部执行记录为父级目录叶

Status: implemented

[English](2026-10-20-external-catalog-leaf.md) | 中文

## Problem

上游 #4394 把父级持有的 subagent 目录扩展为带版本的叶条目：v0 本地模式、v1 来自同步目录的 `unknown` 子级、v2 没有本地子 Session 的 `external` 执行。本分支只对暴露 `localAgent` 的运行编目，外部提供方（ACP、SDK）产生的工作对后代发现不可见。

## Decision

`subagent/catalog` 接受上游定义的三个版本——v0 one-shot/continuable、v1 增加 `unknown`、v2 `external`——`establishExternalCatalogChild(parent, childId, label)` 为没有本地 Session 的运行记录提供方铸造的身份。`start()` 现在为每个返回的运行编目：本地子级走 `establishCatalogChild`，外部运行走 v2 叶。`SubagentCatalogEntry` 暴露 `unknown`/`external` 模式为叶行；格式校验器接受 v2 external 并拒绝版本/模式不匹配的负载。投影 fold 升到 `stateVersion: 3`，因为放宽的接受范围会改变包含较新事实的日志的折叠输出。

上游的 `delivery: 'parent' | 'caller'` 规格字段映射到现有结构而非新增请求成员：`start()` 就是 caller-delivery 面（调用方等待 `run.result`，经自身 tool result 完成模型通知），续接与 `sendMessage` 路径承载 parent delivery。

## Alternatives considered

不引入 external 叶会让远端运行对 `listChildren`/`listDescendants` 保持不可见，并使 wire 视图与上游分叉。新增显式 `delivery` 请求字段会复述本分支 API 面已经编码的区分。

## Consequences

父级目录能把远端执行与本地子级并列枚举；这些条目不铸造本地 Session 事实，读取方不能假设存在可恢复的子级。`SubagentCatalogEntry.mode` 新增两个取值——按 mode 分支的消费方必须显式处理或忽略这些叶。

## Verification

`catalog.spec` 把 v0/v1/v2 事实折叠为有序叶行并拒绝版本/模式不匹配的负载；`service.spec` 通过 mock 提供方经 `start()` 覆盖外部写入。
