# Agent Note: 凭据化 CI 自动化的正式仓库门禁

Status: implemented

[English](2026-09-01-canonical-ci-automation-gates.md) | 中文

## Problem

真实 API 测试和 Issue Project 自动化依赖仓库级凭据、GitHub App 安装和 Project 数据。在非正式仓库运行这些工作流会产生误导性的 secret、认证或 404 失败，也可能操作错误的仓库。

## Decision

凭据化 E2E 和 Issue 自动化工作流只在 `jsjm1986/CoHarness` 工作流仓库中运行，并且必须由对应的仓库变量显式启用。Fork 和其他非正式仓库继续使用无密钥 CI，不接收真实 API secret，也不访问 Issue Project。Issue policy 程序会在任何 GitHub API 请求前独立校验 `GITHUB_REPOSITORY`、事件仓库和配置的正式仓库一致。E2E 工作流继续使用 `pull_request`，不得改用 `pull_request_target` 向不受信任代码暴露 secret。

## Alternatives considered

**对每个 fork 动态运行自动化。** 不采用，因为 fork 不一定拥有所需 Project、GitHub App 安装或仓库权限，动态目标也会让共享 Project 配置失去明确归属。

**使用 `pull_request_target` 运行带 secret 的 E2E。** 不采用，因为在 base 仓库上下文中 checkout 不受信任的 PR 代码并携带 secret 会产生 secret 外泄风险。

**把 404 当作可选的 Issue 或 Project 缺失。** 不采用，因为配置仓库返回 404 表明身份或权限错误，必须保持 fail-closed。

## Consequences

正式仓库必须先配置 `DSH_REAL_API_E2E_ENABLED`、`DSH_ISSUE_AUTOMATION_ENABLED`、`DEEPSEEK_API_KEY_EXTERNAL` 和 GitHub App 凭据，再启用对应工作流。非正式仓库会跳过这些 job，而不是报错。正式仓库身份在工作流门禁和 policy 运行时校验中均显式记录；变更正式仓库时必须同步更新配置、工作流和回归测试。
