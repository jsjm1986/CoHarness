---
description: "Experimental Cordis plugins and runtime libraries, published under experimental names and isolated from default product dependencies."
kind: "package-group"
---

# experimental/ — experimental packages

English | [中文](README.zh.md)

This group contains Cordis plugins and runtime libraries with experimental contracts. Its packages publish with the dsh release family unless excluded by the publication policy; publication carries no stability or support promise. The same engineering, security, documentation, lifecycle, testing, and snapshot requirements apply as for release packages.

| Package | Role | ctx key |
|---|---|---|
| `agent-team/` | Implicit-root Agent Teams roster, durable peer mailbox, shared task DAG, and runtime coordination | `ctx.agentTeams` |
| `tool-agent-team/` | Scoped model-facing Agent Teams tools and collaboration guidance | — |
| [`ptc-runtime-python/`](ptc-runtime-python/README.md) | CPython subprocess backend for the code-execution seam | `ctx.ptcRuntime` |

The [subtree rules](AGENTS.md) define dependency isolation, publication policy, and promotion.

The [Agent Teams subsystem page](../../docs/subsystems/agent-team.md) owns the durable Team types and the `ctx.agentTeams` service API.

## Summary

The experimental group contains prototype capabilities whose contracts can change and carry no support promise. All current packages publish under their `@deepseek-ai/dsh-experimental-*` names, including the opt-in Agent Teams composition, Auto review, Cua Driver providers, browser-use backends, cross-realm Inspector, CPython PTC backend, and browser-worker preview libraries. Released products outside this group must not depend on experimental packages.
