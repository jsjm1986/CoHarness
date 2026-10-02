# Todo

[English](todo.md) | 中文

本页记录 [`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.zh.md) 拥有的持久 todo 词汇。面向模型的工具会整体替换一个 agent（智能体）会话的列表；该包还拥有事件声明、回放投影和不变量配套插件。工具行为与配置见[包 README](../../packages/todo/tool-todo/README.zh.md)；列表条目类型 [`TodoItem`](session.zh.md#todoitem--one-todo-list-entry) 由 core session 声明并记录于该页。

## 持久事件与不变量

该包通过声明合并把 `todo/write: { todos: TodoItem[] }` 加入 `SessionEventMap`。此事件仅写入日志，并携带完整替换列表；生成的[持久化目录](../persistence-catalog.zh.md#todowrite--log-only)会记录其声明位置。该包的不变量配套插件会单次遍历校验现有会话和新发布的会话，随后增量追踪已提交的轮次边界，使每个实时 `todo/write` 都能在追加前得到校验，而无需重新扫描日志。
