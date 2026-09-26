# Agent Note: 将 Agent Teams 作为私有实验性包孵化

Status: implemented

[English](2026-08-18-experimental-agent-teams-packages.md) | 中文

## 问题

Agent Teams 的服务与工具约定仍在变化，但它需要使用真实 Session 日志、subagent 生命周期、工具、示例、快照和仓库检查。把这些包放在产品职责组会使其成为 dsh 发布系列成员，并获得与稳定包相同的发布预期。

没有实际包的 experimental 目录曾经让没有消费方的放置、依赖、promotion 和发布规则长期存在。Agent Teams 提供了具体消费方，但该目录需要机械强制的发布排除与依赖隔离，不能只用文档标记状态。

## 决策

`packages/experimental/agent-team` 与 `packages/experimental/tool-agent-team` 位于 `packages/experimental/`。[实验性包命名决策](2026-08-19-experimental-package-name-prefix.zh.md)负责其 npm 名和 promotion 重命名；[发布拒绝名单决策](../process/2026-09-12-experimental-publication-denylist.zh.md)负责其发布族成员资格，并已取代原先的默认私有规则——这两个包与所有未列入拒绝名单的实验性目录一样，现在通过 `publishConfig.access: public` 发布。本记录保留其目录归属与依赖隔离。

同一个顶层检查会拒绝发布包、发布 app 或 Python runtime 通过 `dependencies`、`optionalDependencies` 或 `peerDependencies` 依赖实验性包。实验性包可以依赖发布包和其他实验性包；测试可以通过 `devDependencies` 使用它们，示例可以显式加载它们。

`packages/experimental/agent-team-profile` 以可选 cordis patch 层组合宿主侧接缝，`packages/experimental/agent-team-web-profile` 增补浏览器层，`packages/experimental/client-ui-agent-team` 承载 Web UI。该 UI 包仅在宿主 Team 服务存在时挂载团队视图，通过 sessions 服务而非 workspace 浏览器打开队友会话，并经授权的 Typert 面调用 `agentTeams/*` 远端方法。

通用的调用方预留 continuable child 身份和精确 direct-child drain 仍属于稳定 Subagent 服务。它们负责 Subagent 身份与 Activation 生命周期，不 import 或命名 Agent Teams；实验性 Team 服务沿允许的方向消费这些能力。

实验性状态只改变兼容性预期。这些包仍须满足仓库的一般文档、不变式、生命周期、安全、单元测试、真实组合测试和快照要求。promotion 前必须评审公开约定、限制、测试证据、发布 payload、运行时依赖方，并由一名具名 owner 接受稳定包义务。

## 曾考虑的替代方案

**把 Agent Teams 留在产品职责组，并标为显式启用。** 显式启用的组合可以控制模型行为，但不会阻止包发布，也不能阻止稳定包对其建立运行时依赖。

**预留空的 experimental 组。** 没有实际包的目录没有 owner，也没有可供测试的发布机制。只有具体包需要这套强制处理时，该组才存在。

**把 Subagent 前置能力移入 experimental 目录。** child 身份分配与 Activation teardown 属于 Subagent owner，且不包含 Team 专用约定。移动或复制这些能力会反转依赖方向，或把同一个生命周期拆到多个包中。

## 后果

Agent Teams 可以使用完整仓库依赖图与质量检查，而不进入正式 tarball，也不会成为受支持的运行时依赖。在 Team 包 promotion 前，发布包不能暴露 Team，因此 CLI 和 Web 实验使用显式示例或实验性组合，而不是已发布的基础组合包。

孵化期间的产品职责分组不够直接。promotion 会按照实验性包命名决策产生路径和 npm 名改动。
