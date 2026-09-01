# Agent Note: 仓库 CI Runner 的可移植默认值

Status: implemented

[English](2026-09-02-portable-ci-runner-defaults.md) | 中文

## Problem

CI 工作流默认选择组织范围的 larger-runner 标签和仅在 master 上运行的自托管备用池。并非每个承载 CoHarness 的仓库都拥有这些标签，因此必需 job 可能一直排队，无法产生结果。为 16 核企业 Runner 调整的 worker 数量也会让标准 GitHub 托管 Runner 过度并发。

## Decision

必需的 Linux job 默认使用 `ubuntu-latest`，非阻塞的原生 Windows job 默认使用 `windows-2025`。只有当仓库变量 `DSH_CI_ENTERPRISE_RUNNERS_ENABLED` 精确设置为 `true` 时，才选择现有的具名企业 Runner 池。现有的 `DSH_CI_FAILOVER_LINUX=selfhosted` 和 `DSH_CI_FAILOVER_WINDOWS=selfhosted` 开关优先于该启用项，并继续禁止 Dependabot 拉取请求使用自托管容量。

worker 与门禁并发度使用同一项容量判断。标准托管 Runner 使用有界的低并发值；企业池或显式选择的自托管池保留已经测量过的较高值。仅在 master 上运行的备用 job 还要求 `DSH_CI_SELF_HOSTED_STANDBY_ENABLED=true`，larger-runner 基准 job 则要求启用企业 Runner。仓库变量缺失时只会选择普遍可用的 GitHub 托管容量，绝不会让可选私有池进入必需路径。

`scripts/ci-workflow.spec.ts` 固定可移植默认值、显式启用项、故障切换优先级和备用池门禁，防止后续工作流修改静默恢复以仓库专属 Runner 标签作为默认值。

## Alternatives considered

**继续默认使用具名企业池，并只记录前置条件。** 不采用：Runner 标签缺失时，必需检查会无限排队，而不是给出可操作的失败；独立仓库不应依赖组织所有的基础设施才能验证拉取请求。

**删除企业 Runner 和自托管 Runner 支持。** 不采用：现有池对经过测量的高并发运行和运维故障切换仍有价值，只需要由仓库显式启用。

**在标准托管 Runner 上继续使用企业级并发度。** 不采用：现有 worker 数量按较大机器校准，在可移植默认池上会增加争用、内存压力和测试不稳定性。

**为 CoHarness 增加仓库专属 Runner 标签。** 不采用：这只会把一种私有基础设施依赖替换为另一种，工作流仍然不可移植。

## Consequences

新仓库无需配置私有 Runner 组，即可在标准 GitHub 托管 Runner 上运行完整的必需 CI。拥有较大或自托管池的组织仍可通过显式变量使用它们，并保留现有故障切换路径。可移植默认值使用较低并发度，运行时间可能更长，但会产生有界结果，而不是无限等待不可用容量。启用私有池现在是管理员拥有的仓库配置变更，不再是工作流中隐含的假设。

## Testing

CI 工作流测试会解析 YAML，并断言标准托管回退、企业池显式启用、自托管故障切换优先级、降低后的可移植并发度、备用池启用条件和基准门禁。仓库 pre-push 类型检查以及最终的拉取请求 CI 会覆盖完整工作流配置。
