# Todo

English | [中文](todo.zh.md)

The durable todo vocabulary owned by [`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.md). The model-facing tool replaces one agent session's whole list; the package also owns the event declaration, replay projection, and invariant companion. Tool behavior and configuration are on the [package README](../../packages/todo/tool-todo/README.md); the [`TodoItem`](session.md#todoitem--one-todo-list-entry) list-entry type is declared by core session and documented there.

## Durable event and invariant

The package declaration-merges `todo/write: { todos: TodoItem[] }` into `SessionEventMap`. The event is log-only and carries the complete replacement list; the generated [persistence catalog](../persistence-catalog.md#todowrite--log-only) records its declaration site. The package's invariant companion validates existing and newly announced sessions in one pass, then tracks committed turn boundaries incrementally so every live `todo/write` is checked before append without rescanning the log.
