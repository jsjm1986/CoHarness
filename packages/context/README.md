# context/ — request-context extensions

English | [中文](README.zh.md)

Product plugins that add model-visible request context without defining a tool. `agent-instructions` is included by the default `dsh-agent-spine-demo` bundle and can be disabled through bundle config; `time-context`, `tmux-context`, `session-reference`, `file-reference`, and `file-reference-local` are opt-in.

| Package | Role | ctx key |
|---|---|---|
| [`session-reference/`](session-reference/README.md) | Bounded snapshots of other sessions | `ctx.sessionReferenceResolver` |
| [`file-reference/`](file-reference/README.md) | File-reference discovery seam and `@file` grammar | `ctx.fileReferences` |
| [`file-reference-local/`](file-reference-local/README.md) | Local-filesystem file-reference provider | — |
| [`time-context/`](time-context/README.md) | Current-time and elapsed-time context | — |
| [`tmux-context/`](tmux-context/README.md) | tmux location context | — |
| [`agent-instructions/`](agent-instructions/README.md) | Workspace-instruction context | — |
| [`userdoc-context/`](userdoc-context/README.md) | Admitted context for user-uploaded documents | `userdoc/attached` |

Session references are documented in [docs/subsystems/session-reference.md](../../docs/subsystems/session-reference.md); the [`agent-instructions` decision record](../../.agents/notes/implemented/feature/2026-06-24-workspace-context.md) owns its per-agent/session isolation and lifecycle split.


## Summary

The context group provides plugins that add model-visible context to each request without defining any tool: workspace instruction files become guidance, `@file` mentions offer path completion, other sessions can be referenced as bounded snapshots, and the model can see the current time and the agent's tmux location. All of them are opt-in except `agent-instructions`, which `dsh-base` includes by default and a profile patch can disable. Context is durable: injected instructions and references enter session history as user-role messages, so they persist, replay, and compact like other conversation content. This page maps the group; each package README owns the per-package contract.
