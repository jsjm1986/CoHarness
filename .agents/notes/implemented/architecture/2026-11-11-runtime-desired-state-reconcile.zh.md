# Agent Note：按期望状态恢复 Runtime

Status: implemented

[English](2026-11-11-runtime-desired-state-reconcile.md) | 中文

## Problem

前台活动不是 Runtime 的运行义务。常驻插件或每月定时任务可以在数周没有浏览器访问后仍然需要运行。只恢复近期活跃实例，会让这些任务在进程故障后长期休眠。

## Decision

`instances.desired_state` 保存持久运行意图。启动将其设为 `running`。基础设施 `shutdown` 和 `failed` 转换在确认终止后仍保留该意图。显式 `manual`、`idle` 和 `access-change` 停止将其设为 `stopped`，并优先于后续基础设施清理。停止失败时保持观测状态 `stopping` 和容量占用，直到监督器确认终止。

`InstanceManager.reconcile()` 检查现有代次，并通过正常鉴权、容量和进程代次准入恢复仍有运行意图的基础设施停机实例。近期使用的历史基础设施停机记录仍可在 `HGW_RECONCILE_WARM_WINDOW_MS`（默认七天）内恢复。该窗口不会使持久运行意图过期。从未启动的分配、显式停止和空闲停止都被排除。

自动恢复不会更新前台活动时间。连续失败退避范围由 `HGW_RECONCILE_BACKOFF_BASE_MS` 和 `HGW_RECONCILE_BACKOFF_MAX_MS` 控制，持续就绪达到 `HGW_RECONCILE_STABLE_MS` 后清除失败记录。`HGW_RECONCILE=off` 关闭自动恢复。协调器不会终止存活的不兼容版本；升级准入由[存活进程策略](2026-11-11-runtime-survivor-retention.zh.md)负责。

## Alternatives considered

**启动每个已分配 Runtime。** 否决：只读目录和未使用的个人分配不能消耗进程。

**只看近期前台活动。** 否决：后台运行义务比浏览器活动持续更久。时间窗口仅用于没有保留运行意图的历史记录。

**新增持久恢复标记。** 否决：`desired_state` 已经表达所需持久意图，第二个字段可能与显式停止决定冲突。

**仅让监督器重新派生。** 否决：这会绕过当前 Gateway 鉴权、配额和代次准入。

## Consequences

常驻工作和定时任务可独立于最后一次浏览器访问恢复，前提是 Runtime 已被启动且没有显式停止或撤权。定时任务仍依赖运行中的 Host，此机制不引入外部定时服务。按需 Runtime 在运行义务结束后继续通过已鉴权的空闲检查回收。恢复与交互请求共享有界启动容量。

SQLite schema 11 为旧测试／本地存储提供相同期望状态语义，保留活跃记录的运行意图，让已停止分配保持停止。PostgreSQL 使用已有期望状态列。测试覆盖长期运行义务、未使用分配、终止失败、停止优先级及活动时间不变。
