# Todo

English | [中文](todo.zh.md)

The [`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.md) tool replaces one agent session's whole list and owns the `todos` replay projection. The Session library declares the durable item and event. Tool behavior and configuration are on the [package README](../../packages/todo/tool-todo/README.md).

Source: [`packages/todo/tool-todo/src/types.ts`](../../packages/todo/tool-todo/src/types.ts)

## `TodoItem` — one list entry

The package re-exports the Session library's [`TodoItem`](session.md#todoitem--one-todo-list-entry) through its `./types` and `./client/types` entries.

## Durable event

The core `SessionEventMap` declares `todo/write: { todos: TodoItem[] }`. The event is log-only and carries the complete replacement list; the generated [persistence catalog](../persistence-catalog.md#todowrite--log-only) records its declaration site.
