# Agent Note: 仓库 CI Runner 的可移植默认值

Status: implemented

[English](2026-09-02-portable-ci-runner-defaults.md) | 中文

## Problem

CI 工作流默认选择组织范围的 larger-runner 标签和仅在 master 上运行的自托管备用池。并非每个承载 CoHarness 的仓库都拥有这些标签，因此必需 job 可能一直排队，无法产生结果。为 16 核企业 Runner 调整的 worker 数量也会让标准 GitHub 托管 Runner 过度并发。

## Decision

必需的 Linux job 默认使用 `ubuntu-latest`，非阻塞的原生 Windows job 默认使用 `windows-2025`。只有当仓库变量 `DSH_CI_ENTERPRISE_RUNNERS_ENABLED` 精确设置为 `true` 时，才选择现有的具名企业 Runner 池。现有的 `DSH_CI_FAILOVER_LINUX=selfhosted` 和 `DSH_CI_FAILOVER_WINDOWS=selfhosted` 开关优先于该启用项，并继续禁止 Dependabot 拉取请求使用自托管容量。

本决策取代[大型托管 Runner 证据](2026-07-22-evidence-based-larger-hosted-runners.zh.md)、[串行参考流程](2026-07-21-serial-cross-platform-ci-reference.zh.md)、[故障切换手册](2026-07-26-ci-failover-runbook.zh.md)和[原生 Windows 拓扑](2026-08-08-native-windows-pull-request-ci.zh.md)中隐含启用企业 Runner 与无条件运行热备演练的默认方式。这些 Note 继续保留测量结果、拓扑依据和操作步骤，但其中的企业与自托管路径只在相应仓库变量明确选择后适用。

worker 与门禁并发度使用同一项容量判断。标准托管 Linux coverage 使用两个单 worker 插桩分区，为测试与轮询设置 30 秒超时，并把插桩和 exempt-heavy 门禁串行执行。标准 consumer 通道一次只运行一个外层门禁，Oxlint 与 publint 各使用一个 worker，普通快照和浏览器快照都串行运行。标准原生 Windows 使用两个 coverage 分区、一个外层门禁 worker、一个 publint worker，以及相同的 30 秒 coverage 超时。企业池或显式选择的自托管池保留已经测量过的较高值。

coverage 清单只在 Windows 上运行真实的持久 PowerShell PTY 检查。POSIX 主机可能提供 `pwsh` 供非交互执行，但 `terminal-bash` 的 PTY 前台交接证据只针对 Windows；在 Linux 上探测该检查会让必需 coverage 门禁在达到阈值前失败。原生 Windows 通道仍保留真实 shell 检查。

consumer 通道还会在运行快照前通过 `npm ci --prefix gateway --omit=dev` 安装 `gateway/package-lock.json`。`gateway/` 是根 pnpm workspace 之外的独立 npm 工程，但它的快照文件属于根 Vitest 快照清单，并会导入 `pg` 等 Gateway 运行时依赖。因此，仅执行根目录 `pnpm install` 不能让这份清单自给自足。

第一次完整的标准 Runner 执行说明了为什么必须同时限制内外两层：四个或八个并发 coverage 分区叠加两个外层门禁 worker，使原本有界的仓库扫描、大文件上传校验、终端空闲观察和 ACP 快照轮询错过截止时间。consumer 通道还在同一台小规格主机上重叠运行构建型快照、lint、包发布检查和浏览器回放。只提高单项测试超时会保留资源争用，并让失败等待更久；因此可移植拓扑先降低进程扇出，只把较大超时用于确实较慢的 coverage 插桩。

仅在 master 上运行的备用 job 还要求 `DSH_CI_SELF_HOSTED_STANDBY_ENABLED=true`，larger-runner 基准 job 则要求启用企业 Runner。仓库变量缺失时只会选择普遍可用的 GitHub 托管容量，绝不会让可选私有池进入必需路径。

可移植托管执行还会让干净检出成为权威环境。构建入口测试从公开入口解析第三方包根目录，不再假设包导出 `./package.json`；consumer 通道会在根快照前安装独立的 Gateway 运行时依赖图；协议断言包含当前 ACP 消息字段和 Provider capability 字段。

`scripts/ci-workflow.spec.ts` 固定可移植默认值、显式启用项、故障切换优先级和备用池门禁，防止后续工作流修改静默恢复以仓库专属 Runner 标签作为默认值。

## Alternatives considered

**继续默认使用具名企业池，并只记录前置条件。** 不采用：Runner 标签缺失时，必需检查会无限排队，而不是给出可操作的失败；独立仓库不应依赖组织所有的基础设施才能验证拉取请求。

**删除企业 Runner 和自托管 Runner 支持。** 不采用：现有池对经过测量的高并发运行和运维故障切换仍有价值，只需要由仓库显式启用。

**在标准托管 Runner 上继续使用企业级并发度。** 不采用：现有 worker 数量按较大机器校准，在可移植默认池上会增加争用、内存压力和测试不稳定性。

**保留两个外层门禁 worker，只提高测试超时。** 不采用：标准 Runner 故障发生时，多个 coverage 进程和无关的构建型门禁正在争用同一组 CPU 与内存。更长的截止时间不能恢复预期的调度边界。

**为 CoHarness 增加仓库专属 Runner 标签。** 不采用：这只会把一种私有基础设施依赖替换为另一种，工作流仍然不可移植。

## Consequences

新仓库无需配置私有 Runner 组，即可在标准 GitHub 托管 Runner 上运行完整的必需 CI。拥有较大或自托管池的组织仍可通过显式变量使用它们，并保留现有故障切换路径。可移植默认值使用较低并发度，运行时间可能更长，但会产生有界结果，而不是无限等待不可用容量。启用私有池现在是管理员拥有的仓库配置变更，不再是工作流中隐含的假设。

## Testing

CI 工作流测试会解析 YAML，并断言标准托管回退、企业池显式启用、自托管故障切换优先级、精确的可移植分区与门禁上限、coverage 超时、独立 Gateway 安装顺序、备用池启用条件和基准门禁。聚焦的 Gateway 快照、built-bin、subagent 组合和 ACP 快照测试覆盖干净安装下的消费方行为。仓库 pre-push 类型检查以及最终的拉取请求 CI 会覆盖完整工作流配置。
