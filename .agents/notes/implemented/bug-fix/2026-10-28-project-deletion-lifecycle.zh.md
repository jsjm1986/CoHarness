# Agent Note: 项目删除保留权限与停机所有权

Status: implemented

[English](2026-10-28-project-deletion-lifecycle.md) | 中文

## Problem

被拒绝的项目删除仍可能停止共享 Runtime。在移除目录记录之前发布已停止的运行时分配，还会允许另一个 Gateway 在删除期间启动替代进程。资源清理必须区分已确认的进程静止与外层存储操作完成。

## Decision

[管理员路由](../../../../gateway/src/admin-api.ts) 在生命周期副作用之前拒绝删除保留的 Steward。标准项目删除将认证参与者传入初始停机转换与目录事务。PostgreSQL 在项目锁之前保留当前有效的账户和组织成员行，要求管理员角色，并在提交停止意图前检查组织可用性。事务在进程终止及资源记账前释放连接，因此单连接池仍可继续工作。获准的停止意图会取消该目标的排队启动。目录移除在终止后重新检查当前管理员权限。

[`withStopped`](../../../../gateway/src/instances.ts) 获取[持久操作记录](../../../../gateway/deploy/postgres/migrations/078_runtime_destructive_operations.sql)，绑定稳定 RuntimeId、节点、进程代次、唯一操作 ID 及持续持有的 Gateway 所有者。数据库在操作结束前阻止代次变化、就绪发布、节点重分配及同一所有者的替代分配，即使其他协调器发布了已停止状态。环境目录使操作记录在活动分配删除后仍然保留。释放要求精确匹配操作及 Gateway 身份；经过的时间不能作为恢复证据。

发起操作的管理器将自己的停止状态发布延后至数据工作结束。确认终止后释放进程容量。从未启动的分配不需要恢复句柄。同步回调失败与状态发布失败分别保留原因。[Gateway 进程证明](../architecture/2026-10-24-gateway-model-ownership.zh.md) 在回调及清理期间持续被持有，不消耗模型额度；close 在注销该证明之前等待管理回调结束。获取结果不确定或释放失败时，操作记录保留至精确释放或证明 Gateway 所有者已结束。仍处于 stopping 的分配在重启前继续要求确认 Runtime 已终止。

[节点记账器](../../../../gateway/src/node-resource-budget.ts) 先回收执行预留，同时为已确认静止的代次保留空登记。该记录避免仍在停止中的分配被视为未登记 Runtime 而阻塞其他工作；其观察状态会拒绝新的执行。停止状态发布或目录移除先于最终登记清理与公平唤醒，包括启动失败与死进程恢复。旧代次继续独立受到隔离。

停止意图之前的权限拒绝不改变 Runtime。获准停机之后发生的撤权可以拒绝目录移除，同时保留项目和文件，并将 Runtime 留在已停止状态。无法确认终止时拒绝数据工作，返回503并保留原因。操作后的状态发布或记账可能在目录删除已提交后失败；运维人员应先检查当前状态再重试。导入及保留文件遵循独立的[项目事务决策](2026-10-23-project-creation-transactions.zh.md)。[进程准入](../architecture/2026-10-23-gateway-runtime-admission.zh.md)、[supervision](../architecture/2026-10-25-local-runtime-supervisor.zh.md) 与[关闭工作队列排空](2026-09-17-stop-all-worker-failures.zh.md) 继续保留各自的所有权规则。

## Alternatives considered

**在进程终止期间持有授权事务。** 停机监督和记账也需要数据库操作；保留唯一连接可能阻止操作完成。

**终止后立即发布已停止。** 另一个协调器可以在破坏性存储操作仍未完成时认领替代进程。

**将资源登记与预留一起移除。** 当分配仍处于停止中时，节点的未登记 Runtime 保护会抑制排队工作。

## Consequences

权限、终止及数据提交结果分别保留。删除失败不保证已经获准的停机会被撤销。自定义 PostgreSQL 组装在分派破坏性操作前注入进程所有权。真实 PostgreSQL/Gateway 转录使用可观察的 HTTP 监听器作为合成 Runtime 载体；独立的 LocalLauncher 回归执行真实子进程。旧语句快照及 SIGKILL 场景验证数据库和内核所有权。这些检查不能证明原生 Windows 行为或真实模型提供方调用成功。
