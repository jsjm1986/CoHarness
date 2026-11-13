# Agent Note: Claude Code 运行仅在 Profile 显式启用时加载工作区设置

Status: implemented

[English](2026-11-13-claude-code-workspace-setting-sources.md) | 中文

## Problem

[Claude Code 提供方](../feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)省略了 Agent SDK 的 `settingSources` 选项，因此每次运行都会相对于父会话 cwd 加载用户、项目和本地 Claude 设置。项目和本地设置位于工作区的 `.claude/settings.json` 与 `.claude/settings.local.json`，可以注册 hooks、MCP 服务器和权限放行规则；而 Claude Code 进程通过 `ctx.subprocess` 启动，不受 dsh 对模型 shell 命令施加的沙箱约束。因此，当模型委派给 `subagent_claude_code` 时，克隆的仓库或其他成员可写的工作区能够在没有任何工作区信任步骤的情况下，以 Host 账户执行任意命令。

## Decision

`@deepseek-ai/dsh-subagent-claude-code` 新增经过验证的 `settingSources` 配置字段，取值为由 `user`、`project`、`local` 组成的数组，默认值为 `['user']`。`claudeQueryOptions` 会把解析后的值传给 SDK，覆盖一次性运行与持续成员轮次；SDK 再把它转发给本机与 SSH 执行的 CLI。用户设置（包括 `CLAUDE_CONFIG_DIR`）仍是模型、账户和产品配置的权威来源；只有 Profile 列出 `project` 或 `local` 时才加载工作区设置。空数组不加载任何基于文件的设置。

## Alternatives considered

**继续继承所有设置范围。** 已否决：这让工作区内容能够选择在 dsh 沙箱外运行的命令。

**硬编码 `['user']`。** 已否决：只服务可信工作区的部署需要项目指令与设置，而仓库约定要求随部署变化的选择是经过验证的配置字段。

**让 Claude Code 进程运行在共享沙箱提供方之下。** 本次修复未采用：这会改变进程模型与 SDK 平台行为；限制设置范围即可在不改变它们的情况下切断工作区 hook 路径。

## Consequences

默认运行不再读取工作区的 `CLAUDE.md` 项目设置、hooks、MCP 服务器或放行规则；依赖这些内容的部署需加入 `settingSources: [user, project, local]`，并接受工作区必须可信的要求。[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/claude-code-workspace-settings/guide.zh.md)列出迁移步骤。`tests/real-product.spec.ts` 使用真实 CLI 与工作区 `SessionStart` hook，验证该 hook 仅在 Profile 显式启用时运行；`tests/subagent-claude-code.spec.ts` 覆盖配置验证与逐实例转发。
