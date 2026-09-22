# preset/ — per-session agent composition

English | [中文](README.zh.md)

An **agent preset** is a directory holding one `agent.cordis.yml`. Mounting it under an agent's scope context gives that session its own tools and prompt sections while every other live session keeps its own, so one process can run several differently composed agents at once.

| Package | Role | ctx key |
|---|---|---|
| `agent-presets/` | Preset vocabulary, filesystem discovery over trusted and user-authored roots, and the guarded per-agent mount | `ctx.agentPresets` |
| `persona/` | The agent persona as a composable row, so a preset can change identity and not only tools | — |

The presets the deployment ships live in [`apps/cli/config/agent-presets/`](../../apps/cli/config/agent-presets) — one directory each, and that directory listing is the roster. Naming them here too would be a second list to keep in step, and the first one to fall behind.

The composition split this group assumes: registries and cross-session facilities are process singletons and stay in the host composition, while a preset carries what one agent contributes to them. A preset that names a row publishing a process-global service is rejected at mount rather than allowed to collide with the next session.

Design: [the per-session agent-preset note](../../.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.md).

The [`AgentPresets` reference](../../docs/subsystems/core.md#ctxagentpresets--agentpresets) records discovery, mounting, inheritance, and recomposition; [scope](../../docs/subsystems/scope.md) owns the scope keys and parent chain the mount uses to join agents, and [system prompt](../../docs/subsystems/system-prompt.md) owns how preset prompt sections register and assemble.


## Summary

The preset group provides per-session agent composition: an agent preset is a directory holding one `agent.cordis.yml`, and a session composed from a preset runs that preset's tools, prompt sections, and skills while every other session keeps its own. `agent-presets` owns the roster — discovery over configured roots plus the harness home, the guarded per-agent mount, and copy-only authoring — and `persona` supplies the composable row that lets a preset change an agent's identity and not only its tools. Together they let one process run several differently composed agents at once.
