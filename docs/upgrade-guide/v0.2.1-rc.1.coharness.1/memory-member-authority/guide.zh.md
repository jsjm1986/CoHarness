---
kind: upgrade-guide
description: "成员 MemoryWriter 调用者改为提供捕获的协作授权，不再仅提供参与者。"
---

# 成员记忆写入者保留协作授权

[English](guide.md) | 中文

## 变更

自行构造成员 `MemoryWriter` 的集成需要把 `participant` 替换为 `authority`。记忆服务会在修改排队期间保留主体有效期和提供方失效状态。内置成员 Remote 方法自行捕获该授权。

代理写入者在条目持久化前检查取消状态。Gateway 授权与转发在 Session 登记和继承恢复期间也遵守取消信号。project 写入在耐久标记之后重新核验当前权限，并拒绝执行状态改变、提供方替换、资格撤销或授权流不可用的情况，空闲整理也不例外。权限检查不预留模型请求额度，也不为模型请求计费。记忆在标记等待期间被关闭，会阻止条目变更。独立成员写入等待期间若变为必须具有协作能力，也会被拒绝。

显式 personal 与 project 模型读取也使用当前 Agent 作用域集合。`memory.enabled: false` 时，每个记忆工具都在访问存储前返回 `memory_invalid`。成员 Remote 读取仍可用于检查保留条目。

在模型读取或搜索等待期间关闭记忆，也会以 `memory_invalid` 拒绝已完成的结果。目录与召回消费者会丢弃撤回作用域中新完成的数据。关闭 `enabled` 或 `recall` 会取消在途选择器，包括排队中的模型请求；所有者读取与已记录的对话历史仍然可用。

## 迁移

1. 在 `ctx.memory.save` 或 `ctx.memory.delete` 的调用者中，于已认证请求内构造 `{ kind: 'member', authority: ctx.collaboration.capture() }`。传递完整捕获对象，不要提取其中的 `participant`。
2. 仅在没有协作提供方的独立组合中省略 `authority`。不得通过省略它来绕过过期主体或已卸载提供方。
3. 对集成执行类型检查，并验证过期的排队写入收到 `collaboration-forbidden` 且条目未改变。参见[记忆服务参考](../../../../packages/memory/memory/README.zh.md#member-remote)。
4. 代理集成通过 `{ kind: 'agent', agent, signal }` 传递操作自身的 `signal`。处理取消或 `execution/forbidden`；发起新的已授权操作，不要携旧授权重试。整理游标集成将同一信号传给 `writeCursor` 或 `writeCursorIfUnchanged`，使已取消的排队工作不能推进进度。

5. 处理记忆关闭时模型工具返回的 `memory_invalid`。发起新的模型操作前重新启用 `memory` 设置节；保持关闭时通过成员 Remote 读取检查保留数据。参见[工具作用域参考](../../../../packages/memory/tool-memory/README.zh.md#scope-resolution)。
