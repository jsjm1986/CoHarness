# Agent Note: 期望态 Runtime 协调器与有界回温

Status: implemented

[English](2026-11-11-runtime-desired-state-reconcile.md) | 中文

## Problem

停止的本地 Runtime 过去只能由用户请求拉起：升级排空把幸存者写成 `stopped`、空闲收割停掉安静的 Runtime、崩溃的 supervisor 被发布为 `failed`——但没有任何机制重启它们。部署后每次"打开界面就干等"都是一次懒冷启动，而持续崩溃循环的 Runtime(实测某项目行 generation 达 11228)可以无限烧启动次数。

## Decision

`InstanceManager.reconcile()` 在启动后约 15s 首次运行、之后每 60s 经既有 `fencedTask` 单飞执行，对持久行集执行两项职责：

- **探测**：对每个仍为 `ready` 的收养驻留租约，检查已跟踪进程(`isAlive`/`hasExited`）或经 `liveEndpoint` 重连。确认死亡的进程以 `failed` 原因停止；资源注册缺失(`unregistered`）**不**视为死亡——探测只在有确证时动作。
- **回温**:`InstanceRepository.warmTargets(cutoff)` 返回本节点 `stopped` 行中 `stop_reason` 为基础设施停止(`shutdown`、`idle`、`failed`）且 `last_activity_at` 落在 `HGW_RECONCILE_WARM_WINDOW_MS`（默认 7 天）内的行，最近活跃优先。每个目标经普通 `ensureRunning(subject, 'passive')` 重启——走完整准入、容量与策略路径——subject 由 `warmSubject()` 依据 `repository.owner` 重建最小集合。

`manual` 与 `access-change` 停止永不复活（SQL 层排除 + passive 意图语义双重保证）。每 boot 的 `reconcileRestarts` 映射把回温尝试封顶在 `HGW_RECONCILE_MAX_RESTARTS`（默认 3)；耗尽的目标计入 `budgeted`，等待下次 boot 或用户请求。`HGW_RECONCILE=off` 可整体关闭。

## Alternatives considered

**supervisor 层 respawn**(launchd/systemd 式进程重启）。否决：respawn 绕过 gateway 准入、容量栅栏与 generation 栅栏；reconciler 复用普通启动管线，使复活的 Runtime 与用户启动的完全等价。

**回温所有停止行**。否决：长期冷置的 Runtime 会在 boot 时空烧启动槽。活跃窗口把回温集限定在可能被使用的空间；显式 `manual` 作为硬语义线不被触碰。

## Consequences

部署重启现在自愈：签名排空→`stopped` 行带 `stop_reason='shutdown'`→首轮 reconcile 无用户干预回温至 `ready`。崩溃恢复从"等下次进入"变成 ~60s 内自动完成，崩溃循环按 boot 封顶——历史失控行从无限 generation 增长变为恰好 3 次尝试后 `budgeted`。回温启动与用户请求共用同一准入 FIFO，批量回温可能瞬时占满 `maxStarting` 槽；交互启动不被抢占，但可能排在进行中的回温准入之后。

## Verification

- `instances.spec.ts`(+4):`shutdown` 停止行回温至 `ready` 而 `manual`/`access-change` 保持 `stopped`；真实 `FAKE_DSH` 子进程经 `/exit` 杀死被发布 `failed` 再回温 `ready`；死亡的收养幸存者经探测发布 `failed`;`HGW_RECONCILE_MAX_RESTARTS=1` 产出 `budgeted` 且行保持停止（与 config 套件共 142/142)。
- `config.spec.ts`：默认 `enabled/7d/3`,`HGW_RECONCILE=off`，非法值拒绝。
- 生产 mac-mini r56：启动签名排空→首轮 reconcile 记录 `{ failed: 0, warmed: 5, budgeted: 0 }`,6 行（admin 个人、mac-mini steward、项目 Runtime）无人值守到达 `ready`；两个崩溃循环行在第 2–3 轮重试（generation 24→25→26、11229→11230→11231）后记录 `{ budgeted: 2 }` 停止重试。
