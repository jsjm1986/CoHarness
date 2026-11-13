---
kind: upgrade-guide
description: "The Claude Code subagent provider no longer loads workspace project or local Claude settings by default."
---

# Claude Code subagents load only user settings by default

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-subagent-claude-code` previously loaded user, project, and local Claude settings for every run, including hooks, MCP servers, and allow rules from the parent Session workspace's `.claude/settings.json` and `.claude/settings.local.json`. The provider now passes the new `settingSources` Config field to the Agent SDK, and the default `['user']` ignores workspace settings and project `CLAUDE.md` instructions. Deployments whose Claude Code runs depend on workspace settings are affected.

## Migration

1. Decide whether every workspace the Claude Code provider instance serves is trusted. Workspace settings can run commands outside the dsh sandbox.
2. Only for trusted workspaces, add `settingSources` to the `subagent-claude-code` row's `config` in `cordis.yml`, for example `settingSources: [user, project, local]`.
3. Run a delegation and confirm that the expected workspace hooks or instructions take effect; without the key, confirm they do not. See the [provider configuration reference](../../../../packages/subagent/subagent-claude-code/README.md#configuration).
