# Agent Note：Gateway 协调的交互桌面租约

Status: implemented

[English](2026-09-19-desktop-resource-coordination.md) | 中文

## 问题

computer-use 与 browser-use 驱动器向共享交互桌面注入输入。provider 的独占注册 seam 只能在单个运行时内串行化驱动器，对跨运行时争用无能为力：个人运行时、项目运行时、子 Agent 与 PTC 调用都可能到达同一桌面，而独立任务之间交错的点击会同时破坏两个任务。协调必须位于 Gateway——它拥有运行时认证、持久化记录与管理权限。

## 决定

Gateway 为每个交互桌面拥有一份**桌面租约**，以不透明的资源对 `{node, desktop}` 为键：承载该桌面会话的执行节点，以及节点上报的桌面标识。`gateway/src/desktop-coordinator.ts` 在持久化仓储之上实现状态机（PostgreSQL `harness.desktop_*` 表，迁移 028；内嵌 SQLite 仓储服务测试）。

- **持有人身份由服务端派生。** 租约请求经认证的运行时回环（`/internal/runtime/desktop/*`）到达；持有人投影自已验证的 `GatewayPrincipalClaims`——运行时 kind/id/代次、用户、scope，外加调用方的 `runId` 关联标识与 `requestId` 去重键。客户端不能自报可信持有人。
- **代次绑定。** `acquire` 将 claims 中的运行时代次与 `InstanceManager.generationOf` 核对；旧代次调用方被拒绝。heartbeat 以同样方式认证，因此重启后的运行时无法续期旧租约。
- **每个连续任务一份租约。** 驱动器在整个任务期间只 acquire 一次——协调器绝不在点击之间轮转租约——持有期间 heartbeat，完成时 release。第二个持有人按资源进入 FIFO 队列，以 `(holder, requestId)` 去重，支持取消，等待时限与队列容量为部署配置。
- **释放必须经确认。** heartbeat 丢失、超时或管理员撤权使租约 `held → stopping`；持有人运行时通过 `confirm-stopped` 确认输入已排空后才释放资源并提升队首。超过停止时限仍未确认，租约转为 `pending-confirm`，桌面保持不可用——不发新租约、不提升队列——直到确认到达或管理员 `clear` 落地。停止不会撤回已送达的输入，产品租约也不约束宿主操作者本人的作业。
- ** fencing 令牌。** 每份租约携带按资源单调递增的 fencing 令牌；桌面宿主用它拒绝被取代持有人的输入。
- **协调者重启。** 租约与队列行均为持久化。启动时 sweep 做调和而非清空：heartbeat 过期的 `held` 行转入 `stopping`，超过期限的 `stopping` 行转入 `pending-confirm`；不做任何静默重新发放。

模型可见结果（已授予、队列位置、已撤权、已丢失）返回给调用方运行时，由其 provider 记入会话；Gateway 在审计轨迹中记录获取、撤权与强制清理决定。

## 备选方案

**仅用进程内注册。** provider 注册 seam 只能在单个运行时内串行化驱动器，无法为同一桌面在个人运行时、项目运行时或子 Agent 之间定序，也没有管理员撤权或跨重启持久的队列。

**把运行时租约当作桌面租约。** 运行时租约服务于暖实例回收记账，不含持有人确认、fencing 或队列语义，混用会让已停止的运行时静默继续持有桌面。

**由客户端声明持有人。** 自报持有人使去重、撤权与旧代次拒绝无法执行；因此持有人身份必须来自已验证的 claims。

## 后果

获取与释放每资源需一次串行事务（PostgreSQL advisory lock、SQLite 库级互斥）——相对其防止的点击交错破坏，成本很小。持有人未确认即消失时桌面进入 `unavailable` 而非被悄悄重发，运维获得显式的恢复决策（`revoke`/`clear`，均入审计），代价是偶发的人工清理。驱动必须遵守 fencing 令牌与停止信号；无视它们的 provider 代码仍可能向已被取代的桌面注入输入。

## 验证

`gateway/tests/desktop-coordinator.spec.ts` 覆盖双运行时争用、旧代次拒绝、FIFO 顺序、requestId 去重、取消、带确认的撤权、heartbeat 丢失 → stopping → pending-confirm → 不可用、协调者重启调和，以及 confirm-stopped 释放；`gateway/tests/postgres.spec.ts` 在真实 PostgreSQL 上验证同一路径（advisory-lock 序列化、队列提升、重启持久化、组织隔离）。部署注意：仅驱动专用桌面并保留紧急停止通道。周期 sweep 以 grant TTL 的一半运行；`HGW_DESKTOP_GRANT_TTL_MS`、`HGW_DESKTOP_STOPPING_TTL_MS`、`HGW_DESKTOP_QUEUE_TTL_MS` 与 `HGW_DESKTOP_QUEUE_CAPACITY` 按部署调整协调窗口。
