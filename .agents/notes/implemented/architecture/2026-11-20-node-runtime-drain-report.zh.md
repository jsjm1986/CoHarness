# Agent Note: 节点排空时逐一确认 Runtime 停止

Status: implemented

[English](2026-11-20-node-runtime-drain-report.md) | 中文

## 问题

Gateway 可以在未验证各托管 Runtime 是否关闭并持久化 Session 日志的情况下停止自身服务。有界的节点排空还需要覆盖多个批次。单个进程超时或停止失败可能掩盖其他代次的完成情况。

## 决定

Gateway 默认在关闭时保留 Runtime 进程，并拒绝新启动。启用 `HGW_DRAIN_RUNTIMES_ON_SHUTDOWN` 后关闭准入，等待未完成的启动结算，再收集已追踪及本节点已分配的代次，包括由 systemd 管理的单元。Gateway 复用各代次的进程与存储限制，最多并发执行八个停止操作。进入排空状态后，电脑拒绝新的 Runtime 流量。管理员仍可向 Runtime 所在的电脑发出明确的停止请求。停止中的当前代次在保有写入位置且受管租约仍有效时，仍可完成检查点，在进程终止前持久化 Session 日志。核对停止状态时独立保留 Session 回执。清单完整、进程停止和 Session 均已确认且未达到节点截止时间，才能报告排空成功。

## 考虑过的替代方案

仅以监督进程完成判断结果，无法区分 Session 已持久化与进程被强制停止。Runtime 排空与 Gateway 其他清理步骤共用一个短期限，可能来不及运行后续批次。独立的停止期限能覆盖多个批次，并保留前后清理阶段的期限。无限等待会使 Gateway 在监督进程或数据库操作阻塞时无法退出。

## 后果

节点日志记录已知的确切代次，在超时时标记未完成的发现和停止，并在停止状态核验失败时保留 Runtime 检查点结果。停止失败保留既有的持久进程与资源约束。确定性测试覆盖多个工作批次、截止时间和代次变更。真实 Gateway 入口使用一次性 PostgreSQL 和合成监督结果，检查已确认、不完整、超时及保留模式的 JSON 报告、退出码和持久分配状态。参见[Gateway 配置](../../../../gateway/README.zh.md)和[托管 Runtime 检查点决定](2026-11-20-managed-runtime-session-shutdown.zh.md)。
