# Agent Note: 受管 Runtime 进程准入

Status: implemented

[English](2026-10-23-gateway-runtime-admission.md) | 中文

## Problem

一个 Gateway 可以为每个账户启动个人 Runtime，并为每个项目启动共享 Runtime。按目标串行化生命周期可以阻止同一目标的重复进程，但不同目标同时启动仍会耗尽 Mac 的内存和 CPU。每实例 systemd 限额不构成节点共享预算，也不适用于 macOS local 启动器。

## Decision

[InstanceManager](../../../../gateway/src/instances.ts) 在物化策略、维护准入或启动进程之前，先取得一个常驻预留和一个冷启槽位。就绪只释放冷启槽位。确认整棵进程树终止后才释放常驻预留；终止失败保留句柄和预留。本地子进程退出通知触发串行清理，启动失败与显式停止遵循相同的终止规则。关闭时先关闭队列准入、取消待启动操作，并等待它们结束，再清理本地进程。这些规则补充 [Gateway 启动所有权](../bug-fix/2026-08-18-gateway-startup-resilience.zh.md)与[维护](2026-09-25-gateway-deployment-maintenance.zh.md)决策。

[容量控制器](../../../../gateway/src/runtime-capacity.ts) 按 FIFO 顺序接纳不同的 Runtime 目标。常驻预算满时等待已有进程停止或满足空闲回收条件，不驱逐忙碌进程。队列大小与等待时间有界，同一目标和启动意图的重试共享待完成操作，停止会取消该目标的排队启动。热 Runtime 调用不申请冷启槽位。PostgreSQL 与 SQLite 仓储在接纳请求前枚举活跃分配；由 supervisor 保留的进程，包括未完成的启动与停止，即使超过调低后的限额也计入预算。不确定的存活状态在确认终止之前持续占用预留。未完成的启动或停止立即拒绝替换；恢复需要管理员成功停止该 Runtime，再显式启动。启动器拒绝时须确认没有遗留进程，或通过 `RuntimeLaunchCleanupError` 交回仍需清理的句柄。

`startRequest.admission` 在有界队列接纳请求、立即预留槽位或可复用热运行时后完成；`startRequest.completion` 仅在通过鉴权的就绪检查后完成。普通 HTTP 代理先等待准入，再返回等待响应，因此队列已满时返回 HTTP 503 `INSTANCE_CAPACITY` 和 `Retry-After`。接纳后，HTML 请求沿用 200 等待页，API 请求沿用 503 `INSTANCE_STARTING`，启动在后台继续。之后的排队超时或取消会拒绝 completion，并保留在准入计数中，但不能替换已经返回的 HTTP 响应。

经过校验的节点设置提供 `HGW_RUNTIME_MAX_STARTING`、`HGW_RUNTIME_MAX_RESIDENT`、`HGW_RUNTIME_MAX_QUEUED` 与 `HGW_RUNTIME_QUEUE_WAIT_MS`。默认值为 2 个冷启、8 个常驻预留、32 个排队目标和 30 秒排队期限。它们是当前 Mac 部署可配置的保护起点，没有经过单 Runtime 内存校准，不证明 16 GiB Mac 能承载 300 个个人 Runtime 或 100 个混合 AI 任务。既有节点配置缺少新增设置时，读取启动环境值或声明的默认值；显式非法值仍会校验失败。

公开快照报告当前及峰值进程／队列数、拒绝数、队列取消与超时数、目标标识符字节数和固定的累计等待分桶。标识符字节数不包含调用方持有的请求数据，不是队列总内存测量。一个 Gateway 所有者对一个节点上的受管进程记账；共用主机的独立 Gateway 与非受管进程不共享这份内存预算。

## Alternatives considered

**把每 Runtime 的 CPU 与内存限额当成节点预算。** 这些限额依赖平台，其总和仍可能超出主机容量。Runtime 进程准入适用于两种启动器，但不声称限制获准 Runtime 内的 CPU 或内存消耗。

**有新目标等待就立即驱逐常驻 Runtime。** 已有租约与任务生命周期规则拥有安全空闲释放职责。带期限的 FIFO 等待保留这些职责，不因容量而终止活跃工作。

**请求终止或子进程根节点退出后立即释放。** 后代进程仍可能占用资源与端口。只有启动器的异步终止完成后才能复用容量；无法确认的终止继续保留预留。

## Consequences

冷启突发具有有界的启动进程数与队列长度，重试不能绕过常驻预算。容量耗尽可能延迟或拒绝尚未启动的空间；调低限额不终止已有空间。Runtime 准入不调度常驻 Runtime 内的 Agent 回合、LLM 请求、工具、终端或其后代进程。这些操作需要自身的跨进程资源所有权与准入；单靠进程数限制不能保护整机免受混合负载影响。

确定性的控制器测试覆盖 100 个目标突发、FIFO、两类限额、取消、超时、既有进程记账与幂等释放。InstanceManager 测试执行真实本地子进程启动、其他目标等待时的热调用、重复重试、排队停止取消、崩溃清理、终止失败时保留预留和关闭静止性。[真实 HTTP 代理测试](../../../../gateway/tests/proxy.spec.ts) 将实际 manager 与可控启动器组合，验证就绪前的满队列拒绝、已接纳请求的等待响应和释放容量后的恢复。配置测试拒绝非法值，节点配置测试覆盖持久化与新增字段读取。时延与常驻内存校准、混合负载基准以及完整应用的容量失败转录仍需单独提供证据。
