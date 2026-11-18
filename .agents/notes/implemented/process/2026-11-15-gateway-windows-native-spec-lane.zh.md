# Agent Note: Gateway Windows 原生 spec 车道

Status: implemented

[English](2026-11-15-gateway-windows-native-spec-lane.md) | 中文

## Problem

Gateway 测试套件此前只在 Linux `gateway` CI 作业中运行，因此所有以 `process.platform === 'win32'` 门控的 spec 主体都没有车道：[local-runtime-win32-job.spec.ts](../../../../gateway/tests/local-runtime-win32-job.spec.ts) 的 Job Object 与创建时刻分支、node-private specs 的 Windows ACL 分支、`node-agent.spec.ts` 的 `schtasks` 与命名管道路径，以及 [run-windows-principal-clock.mjs](../../../../gateway/tests/run-windows-principal-clock.mjs)——它断言 `platform === 'win32'`，在任何车道上都从未运行过。[Windows Runtime Job ownership note](../architecture/2026-11-12-windows-runtime-job-ownership.zh.md) 记录了代价：Job/创建路径的首次真实执行发生在生产节点上，暴露出 FILETIME 解码中的 `readBigUInt64LE` 越界错误。在 Windows 上直接跑全套 `npm test` 也不是解法——大量 fixture 假定 POSIX 设施（`flock`、`getuid`、POSIX 路径），多个车道还需要 Windows runner 无法承载的 PostgreSQL 服务，全量跑会以与被测 Windows 代码无关的原因变红。

## Decision

`.github/workflows/ci.yml` 新增 `gateway-windows` 作业，只承担对 Windows 有意义的切片。runner 池选择器与 `windows-native` 逐字一致——默认 `windows-2025`，`DSH_CI_ENTERPRISE_RUNNERS_ENABLED` 时使用企业命名池，同仓库非 Dependabot PR 在 `DSH_CI_FAILOVER_WINDOWS=selfhosted` 下落到 `[self-hosted, dsh-win-ci, windows]`——池策略保持单一决策。车道以 `npm ci` 安装 `gateway/`，按 Linux `gateway` 作业的同样方式用 `--ignore-scripts` 安装 workspace 供声明产物，运行 `pnpm run build:native-system && pnpm run build:lib:host` 产出 vitest alias 消费的产物图，然后以显式文件清单运行 `npm test --prefix gateway --`：十二个其主体含 `win32` 分支或覆盖 Windows 属源文件的 spec(`config-windows-paths`、`local-runtime-{win32-job,launcher,native-control,owner,owner-acl-cache,protocol,reboot}`、`node-access-config`、`node-agent`、`node-private-{file,sqlite}`)。文件内的纯 POSIX 主体经 `skipIf` 自跳，因此同一命令在 POSIX 主机上保持绿色、可在本地预演。随后 `npm run build --prefix gateway` 产出 `lib/`，`node tests/run-windows-principal-clock.mjs` 原生执行 principal-clock 证明。

触发遵循让该车道值得其耗时的两个独立信号：`gateway_mode == 'full'`——共享 Gateway 代码即使不碰 Windows 属文件也可能回归 Windows 行为——或 `proof_native_windows`，外加每次 master push、每夜 schedule 与 `full-audit` 派发，使覆盖不等待 PR。任一条件成立时 `all checks passed` 要求该作业；`scripts/verify-pr-results.ts` 从工作流读取的同一组 `gatewayMode`/`nativeWindows` 计划字段推导该要求，`scripts/ci-workflow.spec.ts` 记录该作业加入的 push 可达集合。

## Verification

curated 命令已在本地运行：十二个 spec 文件在 macOS 上全部通过（103 个测试，5 个 POSIX/Windows 专属主体自跳），证明文件清单可解析、门在 Windows 之外可预演。`ci-workflow.spec.ts` 与 `verify-pr-results.spec.ts` 覆盖触发与准入逻辑——71 个 workflow 脚本测试通过。剩余证明即车道在 `windows-2025` 上的首跑：这是 win32 spec 主体的首次 CI 执行，首次绿色本身是证据，首次红色则恰好暴露车道存在所要捕捉的潜在缺陷。

## Alternatives considered

**在 Windows 上跑全量 `npm test`。** 否决——假定 POSIX 的 fixture 与 PostgreSQL 服务车道会以与 Windows 正确性无关的原因失败，淹没真实信号。

**扩展 Wine 车道。** 否决——Wine 无法提供内核 Job Object、`Get-Acl` 语义、命名管道或 `schtasks`；它已作为 PR 冒烟服役，且已被记录为不等价于原生验证。

**在 Windows runner 上托管 PostgreSQL。** 否决——Windows 托管 runner 无法运行 Linux `postgres` 服务容器，且 PostgreSQL 车道测的是数据库行为而非 Windows 专属代码；Linux `gateway` 作业已承担。

## Consequences

所选 specs 中的每个 Windows 分支现在都拥有 CI 车道，`proof_native_windows` 变更在 PR 上执行真实分支而非等到生产。spec 清单刻意是工作流可见的允许列表：新增含 win32 主体的 spec 需显式加入清单才会进入车道——这保持车道只覆盖其主体确实按平台门控的文件。PostgreSQL 支撑的 specs 仍归 Linux 所有；它们都不按 `process.platform` 门控。
