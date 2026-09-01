# Agent Note: 拉取请求 CI 的可移植恢复边界

Status: implemented

[English](2026-07-23-portable-required-pull-request-ci.md) | 中文

**当前 Runner 放置。** [可移植 Runner 默认值](2026-09-02-portable-ci-runner-defaults.zh.md)取代本文把企业池作为主路径以及缺少自动标准托管路径的配置。必需清单与诊断清单的职责边界，以及不得通过跳过证据来恢复绿色状态的结论仍然适用。

## 问题

分配到组织自有运行器标签的拉取请求必需作业，在 GitHub 无法为这些池分配运行器时会持续排队。工作流本身有效，GitHub 标准托管作业仍能通过，但 `all checks passed` 始终无法启动，原本健康的拉取请求因此无法满足分支保护要求。

账单状态正常、运行器定义处于 `Ready` 状态以及较高的自动扩缩容上限，都不能证明指定的运行器池可以接收作业。必需的正确性检查需要预先明确一条可移植恢复路径，即使日常低延迟路径依赖仓库外部的运行器预配也不例外。

## 决策

[CI](../../../../.github/workflows/ci.yml) 默认在标准 `ubuntu-latest` 上运行必需的 Node 24 主作业和稳定的 `all checks passed` 聚合流程。`DSH_CI_ENTERPRISE_RUNNERS_ENABLED=true` 可以选择具名企业池，而对于可信且非 Dependabot 的拉取请求，`DSH_CI_FAILOVER_LINUX=selfhosted` 具有更高优先级。聚合流程既不检出代码，也不执行仓库门禁。必需的 Windows 作业在标准 `ubuntu-latest` 上通过 Wine 运行 Windows Node，覆盖阻断性检查范围；一个独立的原生 `windows-2025` 作业会自动启动，但不参与聚合流程（[双 Windows 决策](2026-08-08-native-windows-pull-request-ci.zh.md)）。标准托管作业还保留 Node 22.19、Node 26、Python SDK 单元测试套件与[发布形态的 Linux x64 Python 运行时验证](../testing/2026-08-12-required-python-runtime-pull-request-ci.zh.md)。

三项 Linux 主作业、Node 兼容性、Python SDK 单元测试套件、Python 运行时验证和 `windows node 24 / wine blocking` 继续作为 `all checks passed` 的依赖项；`windows node 24 / native complete` 被刻意排除。分支保护继续要求 `e2e` 和 `all checks passed`。可移植标签是自动默认值，而不是通过跳过或降级证据实现的后备机制。选择外部容量的部署可以删除企业或故障切换变量，再对同一分支头重新运行，从而返回可移植标签。

[大型运行器决策](2026-07-22-evidence-based-larger-hosted-runners.zh.md)负责实测的聚合拓扑。[可移植 Runner 默认值](2026-09-02-portable-ci-runner-defaults.zh.md)负责当前放置和按容量区分的 worker 上限。[跨平台串行参考流程](2026-07-21-serial-cross-platform-ci-reference.zh.md)为显式启用的部署保留独立自托管完整性演练；仅存的托管串行参考是禁用的 `serial-macos`。手动大型运行器套件保留规格比较，同时不扩大普通必需矩阵。

## 曾考虑的替代方案

**继续让企业容量作为默认主路径。** 标准运行器上的完整作业反馈可能更慢，也仍会遇到共享容量排队，但当仓库并不拥有私有池时，私有标签可能无限排队。当前决策接受延迟代价，换取可运行的正确性默认值，同时把企业容量保留为显式性能选项。

**根据标称核心数选择企业规格。** 基准测试表明扩展效果不呈单调变化，设置耗时也存在波动，因此必需运行器池改由完整作业的精确测量结果选定。

**在容量不可用时跳过检查或降低其级别。** 这种方式通过丢弃证据而非执行仓库的必需约定来使状态变绿。

**在每台主机上使用同一工作线程策略。** 外层门禁并发与内层工具工作线程在 Linux、Windows 和标准运行器上的争用方式不同；按主机实测的上限可以避免新增核心反而拖慢执行。

## 后果

普通拉取请求在 Linux 关键路径上使用 GitHub 标准托管容量，Wine 作业则让必需的 Windows 判定继续使用标准 Linux 运行器容量。独立原生作业使用标准 Windows 运行器容量，不会延迟或改变聚合流程。部署可以显式选择企业或自托管容量，而无需改变必需清单。一次针对确切分支头的实际运行会区分分支保护采用的命令与单独的诊断约定；排队延迟与每个作业从 `startedAt` 到 `completedAt` 的执行区间分开报告。

仅改变运行器池定义的状态，不足以证明它可以接收作业。使用外部标签的部署必须验证其分配能力，并可在重跑前恢复可移植默认值。恢复过程绝不能通过省略必需 Linux 作业或聚合流程来让状态变绿。
