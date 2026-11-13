---
kind: upgrade-guide
description: "Claude Code 子代理提供方默认不再加载工作区的项目或本地 Claude 设置。"
---

# Claude Code 子代理默认只加载用户设置

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-subagent-claude-code` 此前在每次运行时都会加载用户、项目和本地 Claude 设置，包括父会话工作区 `.claude/settings.json` 与 `.claude/settings.local.json` 中的 hooks、MCP 服务器和放行规则。提供方现在把新的 `settingSources` 配置字段传给 Agent SDK，默认值 `['user']` 会忽略工作区设置和项目 `CLAUDE.md` 指令。Claude Code 运行依赖工作区设置的部署会受到影响。

## 迁移

1. 判断该 Claude Code 提供方实例服务的所有工作区是否都可信。工作区设置可以在 dsh 沙箱之外运行命令。
2. 仅当工作区可信时，在 `cordis.yml` 中 `subagent-claude-code` 配置项的 `config` 下加入 `settingSources`，例如 `settingSources: [user, project, local]`。
3. 运行一次委派，确认预期的工作区 hooks 或指令生效；未配置该键时，确认它们不生效。参见[提供方配置参考](../../../../packages/subagent/subagent-claude-code/README.zh.md#configuration)。
