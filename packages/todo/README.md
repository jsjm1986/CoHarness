# todo/ — todo / planning capability family

English | [中文](README.zh.md)

The model-facing todo capability. It is a single **product** package because one agent session owns the list; there is no replaceable provider contract.

| Package | Role | ctx key |
|---|---|---|
| [`tool-todo/`](tool-todo/README.md) | Stores and exposes the session's todo list. | (registers on `ctx.tools`) |

The child README owns the tool, persistence, and rendering contract.

The event payload is documented on [docs/subsystems/session.md](../../docs/subsystems/session.md).


## Summary

The todo group gives agents a session-level task list to plan with: add tasks, mark them in progress, and check them off, with the same list persisting across turns and reopened sessions. It is one product package that provides the `todo_write` tool; the list belongs to the agent session that created it, and each update replaces the whole list. Interactive hosts show the standing plan from the list, while the group itself ships no UI.
