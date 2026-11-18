---
kind: upgrade-guide
description: "The send_message tool argument `agent_id` is renamed to `agent` and names agents by tree position."
---

# `send_message` names agents, not ids

English | [中文](guide.zh.md)

## Change

The `send_message` tool's target argument changed from `agent_id` — an opaque branded session identifier — to `agent`, the target agent's name as reported by `list_agents` within the caller's subagent tree. Any integration that drives the model-facing tool surface directly (recorded session fixtures, scripted tool calls, protocol replay) and still passes `agent_id` is rejected as an unknown argument; a stored identifier also no longer resolves because names are tree-relative, not global.

## Migration

1. In replay scripts, fixtures, and protocol clients that construct `send_message` calls, rename the argument `agent_id` → `agent` and pass the agent's name (for example `"reviewer"`), as `list_agents` reports it.
2. Integrations holding previously recorded session identifiers resolve them through the session tree (`list_agents`, `session_event_read`) instead of passing them back to the tool.
3. Confirm the call lands: the tool result reads `message delivered to agent <name>` and the target session shows a new inbox message.
