# workspace/ — workspace entity family

English | [中文](README.zh.md)

This family owns persistent workspaces: user directories with titles and ordered session membership.

| Package | Role | ctx key |
|---|---|---|
| [`workspace/`](workspace/README.md) | Registers workspaces and accounts for their sessions | `ctx.workspaceRegistry` |

The [workspace package reference](workspace/README.md) owns lifecycle, persistence, and deletion semantics.

The subsystem reference — the entity, realpath canon, registration/resolution — is [docs/subsystems/workspace.md](../../docs/subsystems/workspace.md); storage design in the [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).


## Summary

The workspace family lets a host product keep an ordered list of named projects and group each project's sessions by directory. Users can browse those projects and sessions, hide a session from the grouping without deleting it, and remove a project without deleting its folder or session history. Hidden or removed sessions remain available as ungrouped history. Choose this family for a persistent project surface; it requires session storage and a persistence backend, and it does not expose tools, prompts, or session events to the model.
