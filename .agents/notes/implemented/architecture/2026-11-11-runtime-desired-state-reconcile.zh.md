# Agent Note: 期望态 Runtime 协调器与有界回温

Status: implemented

[English](2026-11-11-runtime-desired-state-reconcile.md) | 中文

## Problem

停止的本地 Runtime 过去只能由用户请求拉起：升级排空把幸存者写成 `stopped`、空闲收割停掉安静的 Runtime、崩溃的 supervisor 被发布为 `failed`——但没有任何机制重启它们。部署后每次"打开界面就干等"都是一次懒冷启动，而持续崩溃循环的 Runtime(实测某项目行 generation 达 11228)可以无限烧启动次数。

## Decision

`InstanceManager.reconcile()` 在启动后约 15s 首次运行、之后每 60s 经既有 `fencedTask` 单飞执行，对持久行集执行两项职责：

- **探测**：对每个仍为 `ready` 的收养驻留租约，检查已跟踪进程(`isAlive`/`hasExited`）或经 `liveEndpoint` 重连。确认死亡的进程在按 runtime 串行的车道上、针对**观测到的** generation 以 `failed` 原因停止——竞争中的替代启动不会被取消或终止；资源注册缺失(`unregistered`）**不**视为死亡，探测只在有确证时动作。行仍为 `starting` 且已超 `HGW_READINESS_TIMEOUT_MS` 的收养租约按同法结算：该截止即启动承诺自身的预算，过期的 `starting` generation 不可能再发布 `ready`——它只在启动路径本身死于半途时存在（Windows 节点实测：supervisor 在 Gateway 重启窗口内 exit-0，行留在 `starting`、收养的租约以 `RuntimeStartBlockedError` 永久挡住后续启动）。启动若死于 supervisor 认领 owner 证据之前，则不存在任何被监督进程，该边界直接结算行并释放租约。
- **回温**:`InstanceRepository.warmTargets(cutoff)` 返回本节点 `stopped` 行中 `stop_reason` 为基础设施停止(`shutdown`、`failed`）且 `last_activity_at` 落在 `HGW_RECONCILE_WARM_WINDOW_MS`（默认 7 天）内的行，最近活跃优先。每个目标经 `startRequest(subject, 'passive', undefined, { recordActivity: false })` 重启——走完整准入、容量与策略路径，subject 由 `warmSubject()` 依据 `repository.owner` 重建最小集合——但 `beginStart` 不触碰 `last_activity_at`，无人值守的回温无法自行续期回温窗口。

`manual`、`access-change` 与 `idle` 停止永不复活：前两条是硬语义线，`idle` 是收割器按 on-demand 策略下的裁决——回温它会对抗当初停掉它的策略。`reconcileRecovery` 映射施加连续失败退避：确认死亡与启动失败计数，拒绝（`blocked`、容量 `cancelled`）只顺延一个基础间隔；重试延迟从 `HGW_RECONCILE_BACKOFF_BASE_MS`(60s）起按失败翻倍、封顶 `HGW_RECONCILE_BACKOFF_MAX_MS`(30m)；持续 `HGW_RECONCILE_STABLE_MS`(10m）保持 ready 则清除连败记录。`HGW_RECONCILE=off` 可整体关闭。

## Alternatives considered

**supervisor 层 respawn**(launchd/systemd 式进程重启）。否决：respawn 绕过 gateway 准入、容量栅栏与 generation 栅栏；reconciler 复用普通启动管线，使复活的 Runtime 与用户启动的完全等价。

**回温所有停止行**。否决：长期冷置的 Runtime 会在 boot 时空烧启动槽。活跃窗口把回温集限定在可能被使用的空间；显式 `manual` 作为硬语义线不被触碰。

**每 boot 尝试次数上限**。否决：绝对的每 boot 计数会把一个偶发失败的 Runtime 永久饿到下次部署，且把未消耗 generation 的拒绝也计入。按失败归因的指数退避在无终态的前提下约束重试频率，持续 ready 的观测证明恢复后清除记录。

## Consequences

部署重启现在自愈：签名排空→`stopped` 行带 `stop_reason='shutdown'`→首轮 reconcile 无用户干预回温至 `ready`。崩溃恢复从"等下次进入"变成 ~60s 内自动完成，崩溃循环进入几何级重试而非无限空转或硬性的每 boot 终止——历史失控行在退避饱和后至多每 30 分钟重试一次。回温后无人使用的 Runtime 保持原 `last_activity_at`，空闲收割只会恰一次把它收为 `idle`，此后直到真实使用前都保持停止。回温启动与用户请求共用同一准入 FIFO，批量回温可能瞬时占满 `maxStarting` 槽；交互启动不被抢占，但可能排在进行中的回温准入之后。

## Verification

- `instances.spec.ts`:`shutdown` 停止行回温至 `ready` 而 `manual`/`access-change`/`idle` 保持 `stopped`；真实 `FAKE_DSH` 子进程经 `/exit` 杀死被发布 `failed` 再回温 `ready`；死亡的收养幸存者经探测发布 `failed`；对已被竞争启动替换 generation 的行探测不终止任何进程；超过就绪时限的 `starting` generation 被结算 `failed` 而未到期者留给其自身启动；回温启动不触碰 `last_activity_at`；连续启动失败几何退避、持续 ready 观测清除连败。
- `config.spec.ts`：默认 `enabled/7d/60s/30m/10m`,`HGW_RECONCILE=off`，非法值拒绝。
- 生产 mac-mini r56（退避改造前的构建）：启动签名排空→首轮 reconcile 记录 `{ failed: 0, warmed: 5, budgeted: 0 }`,6 行（admin 个人、mac-mini steward、项目 Runtime）无人值守到达 `ready`；两个崩溃循环行在第 2–3 轮重试（generation 24→25→26、11229→11230→11231）后停止重试。退避所闸控的排空→回温路径未变。
