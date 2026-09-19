# experimental/ — private experimental packages

English | [中文](README.zh.md)

This group contains prototypes and internal-only Cordis plugins that use the repository's real runtime without joining an official release. Its packages are private, carry no stability or support promise, and retain the same engineering, security, documentation, lifecycle, testing, and snapshot requirements as release packages.

| Package | Role | ctx key |
|---|---|---|
| `agent-team/` | Implicit-root Agent Teams roster, durable peer mailbox, shared task DAG, and runtime coordination | `ctx.agentTeams` |
| `tool-agent-team/` | Scoped model-facing Agent Teams tools and collaboration guidance | — |
| [`ptc-runtime-python/`](ptc-runtime-python/README.md) | CPython subprocess backend for the code-execution seam | `ctx.ptcRuntime` |

The [subtree rules](AGENTS.md) define dependency isolation, release exclusion, and promotion.

The [Agent Teams subsystem page](../../docs/subsystems/agent-team.md) owns the durable Team types and the `ctx.agentTeams` service API.
