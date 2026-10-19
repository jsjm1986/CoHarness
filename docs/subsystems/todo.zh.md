# Todo

[English](todo.md) | 中文

[`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.zh.md) 工具整体替换一个 agent（智能体）会话的列表，并拥有 `todos` 回放投影。Session 库声明持久列表项和事件。工具行为与配置见[包 README](../../packages/todo/tool-todo/README.zh.md)。

源码：[`packages/todo/tool-todo/src/types.ts`](../../packages/todo/tool-todo/src/types.ts)

## `TodoItem`：一条列表项

本包通过 `./types` 和 `./client/types` 入口重导出 Session 库的 [`TodoItem`](session.zh.md#todoitem--one-todo-list-entry)。

## 持久事件

核心 `SessionEventMap` 声明 `todo/write: { todos: TodoItem[] }`。此事件仅写入日志，并携带完整替换列表；生成的[持久化目录](../persistence-catalog.zh.md#todowrite--log-only)会记录其声明位置。
