# Agent Note: Claude Code runs load workspace settings only by Profile opt-in

Status: implemented

English | [中文](2026-11-13-claude-code-workspace-setting-sources.zh.md)

## Problem

The [Claude Code provider](../feature/2026-08-04-claude-code-and-codex-subagent-backends.md) omitted the Agent SDK `settingSources` option, so every run loaded user, project, and local Claude settings relative to the parent Session cwd. Project and local settings live in the workspace's `.claude/settings.json` and `.claude/settings.local.json`. They can register hooks, MCP servers, and permission allow rules, and the Claude Code process starts through `ctx.subprocess` outside the sandbox dsh applies to model shell commands. A cloned repository or a workspace another member can write therefore executed arbitrary commands under the Host account when the model delegated to `subagent_claude_code`, with no workspace trust step.

## Decision

`@deepseek-ai/dsh-subagent-claude-code` adds a validated `settingSources` Config field, an array of `user`, `project`, and `local` that defaults to `['user']`. `claudeQueryOptions` passes the resolved value to the SDK for one-shot runs and persistent member turns, and the SDK forwards it to the CLI for local and SSH execution. User settings, including `CLAUDE_CONFIG_DIR`, remain authoritative for model, account, and product configuration; workspace settings load only when the Profile names `project` or `local`. An empty array loads no file-based settings.

## Alternatives considered

**Keep inheriting every setting scope.** Rejected: it lets workspace content choose commands that run outside the dsh sandbox.

**Hard-code `['user']`.** Rejected: deployments with only trusted workspaces need project instructions and settings, and repository conventions require deployment-varying choices to be validated Config fields.

**Run the Claude Code process under the shared sandbox provider.** Not chosen for this fix: it changes the process model and SDK platform behavior; restricting the setting scopes closes the workspace-hook path without it.

## Consequences

Default runs no longer read workspace `CLAUDE.md` project settings, hooks, MCP servers, or allow rules; deployments that relied on them add `settingSources: [user, project, local]` and accept the trusted-workspace requirement. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/claude-code-workspace-settings/guide.md) lists the migration. `tests/real-product.spec.ts` runs the real CLI with a workspace `SessionStart` hook and verifies the hook runs only when the Profile opts in; `tests/subagent-claude-code.spec.ts` covers Config validation and per-instance forwarding.
