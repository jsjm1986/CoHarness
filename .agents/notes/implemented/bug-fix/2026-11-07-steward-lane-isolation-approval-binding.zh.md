# Agent Note: Steward 读通道隔离与按语句绑定的审批

Status: implemented

[English](2026-11-07-steward-lane-isolation-approval-binding.md) | 中文

## 问题

`StewardQueryService` 从共享网关连接池借出语句连接，因此一条读分类的语句仍可破坏部署：`READ ONLY` 阻止写入但挡不住 `set_config`（会话级 GUC 在 COMMIT 后残留在池化连接上）、`pg_terminate_backend`/`pg_cancel_backend`（信号可触达其他后端）、`pg_advisory_lock`（会话级锁跨 COMMIT 存活）、文件读取、`dblink` 或 `pg_sleep`。一条成功语句会把被污染的连接还给所有网关功能共用的连接池。另一方面，`verifyApproval` 只校验审批 *id*：没有任何机制把授权绑定到操作员预览过的那条语句，同 runtime 内任何拿到该 id 的代码都能在 TTL 内用 `allowed-once` 执行任意写。

## 决策

读分类语句先过 `READ_LANE_DENY`（[steward-query.ts](../../../../gateway/src/postgres/steward-query.ts)）：在触碰任何连接之前，语句被剥离注释、字符串体、标识符引号与 `pg_catalog.` 限定，凡调用了效果越出 `READ ONLY` 的函数即返回 `steward-statement-forbidden`。语句还改为在独立小池（`dsh-steward-query`，在 [index.ts](../../../../gateway/src/index.ts) 接入）上执行而不再使用共享池，且每个成功连接在归还前执行 `DISCARD ALL` 清理——三层独立防线，漏网条目或会话残留都到不了共享连接。审批校验现在把已声明交互的 `call_id` join 到持久化的 `tool/call` 事件，并要求 `arguments.sql` 与被执行的语句完全相等，因此一次审批只能花在预览过的那条写上；事件缺失或参数畸形一律判负。`dryRun` 的 EXPLAIN 不受影响，因为内部语句不会执行。

## 备选方案

**在归还时重置共享客户端。** 全局清洗池化连接能保护所有借用方，但 steward 通道是唯一执行对抗性 SQL 的调用者；隔离它保住共享池的快路径并缩小审计面。

**新列持久化已批准语句。** `conversation_interaction_responses` 已记录 `call_id`，会话日志也已存有精确参数——复用持久化数据免去了本身可能被攻击的平行载荷，也不需要迁移。

## 影响

读通道无法改动会话状态、触达兄弟后端或持有跨语句锁；每次拒绝照常留痕。早于 `call_id` 记录时代的审批会被拒绝而非放行，与该通道的"疑则拒绝"姿态一致。与预览相差哪怕一个空白的写也会被拒——runtime 必须呈交它打算执行的那条语句。
