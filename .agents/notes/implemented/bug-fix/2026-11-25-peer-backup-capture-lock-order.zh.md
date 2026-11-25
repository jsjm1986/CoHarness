# Agent Note: Lock peer-backup policies before scheduled capture rows

Status: implemented

[English](2026-11-25-peer-backup-capture-lock-order.md) | 中文

## Problem

手动 capture 录取与定时 capture claimant 都会为同一 policy 插入 `harness.peer_backup_work`。手动路径先对 policy 行执行 `FOR UPDATE`，检查待处理 work，再插入子行。调度器此前先插入子行，之后 PostgreSQL 的外键触发器才回访父 policy。两个操作重叠时，手动事务持有父行锁并等待调度器在部分唯一索引中的未提交子行，而调度器的外键触发器又等待手动事务持有的父行锁。PostgreSQL 正确报告死锁；管理员侧 capture 请求因此表现为暂时性 503。

## Decision

定时 claimant 现在在创建到期 capture work 的 `INSERT ... SELECT` 中，按稳定 policy-id 顺序以 `FOR UPDATE` 锁定到期的 `peer_backup_policies` 行。手动与定时录取因此都先取得父 policy，再插入子 work。完成串行化后，`ON CONFLICT DO NOTHING` 仍是 capture 已 queued 或 running 时的幂等机制。

## Alternatives considered

- **只在手动 enqueue 中处理唯一冲突**——冲突处理仍是有用的幂等保护，但它不能消除父/子锁倒置；PostgreSQL 只能通过杀死一个事务来解除这种死锁。
- **用 advisory lock 串行 capture 创建**——policy 行已经精确表示该资源，并且管理员变更也会锁它；第二套锁命名空间只会增加排序规则，却不能保护普通 policy 更新。
- **删除部分唯一索引并稍后去重**——重复任务会先到达相互独立的 restic 执行路径，削弱同一 policy 至多一个待处理 capture 的不变量。

## Consequences

调度器创建到期 work 时提交的手动 capture 要么返回既有 operation，要么先赢得父行锁；两条路径都不会死锁。调度器录取会短暂持有父 policy 行，因此编辑和手动 capture 请求会与它串行。测试 barrier 只使用 PostgreSQL advisory lock 把重叠固定在确定位置；生产锁仍保持为行级锁。

## Verification

`gateway/tests/peer-backup-postgres.spec.ts` 用 advisory-lock barrier 把手动录取固定在已取得父锁、尚未插入子行的位置，启动 scheduler claimant，证明双方确实重叠在锁等待中，然后释放 barrier。该测试在修复前确定性死锁，修复后通过。同一文件的真实 restic rotate 流程也已在本地通过。
