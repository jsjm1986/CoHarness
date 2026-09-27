# Agent Note：Gateway 部署维护控制面

Status: implemented

[English](2026-09-25-gateway-deployment-maintenance.md) | 中文

## 问题

共享 PostgreSQL 的部署需要所有 Gateway 节点共同遵守的升级与恢复流程。启动迁移能应用 schema 变更，但无法停止写者、协调备份，或阻止恢复前启动的进程覆写恢复结果。`deploy/postgres` 的 shell 脚本只产生转储而不协调在服集群，并发写者可能在切换点留下数据库与受管文件不一致的状态。

## 决策

[迁移 041](../../../../gateway/deploy/postgres/migrations/041_maintenance_control.sql) 为每个组织建立耐用控制面。`harness.cluster_control` 保存模式（`serving`/`maintenance`/`restoring`）、维护纪元、单调写纪元和窗口备注。`harness.deployment_operations` 是操作台账；`harness.backup_records` 登记每个转储及其受管文件清单、验证状态和取材时的写纪元。`compute_nodes.maintenance_applied_epoch` 记录各节点写门已观察到的纪元。

[维护服务](../../../../gateway/src/postgres/maintenance-service.ts) 驱动状态迁移。进入维护会推进每个写者必须确认的纪元；[server.ts](../../../../gateway/src/server.ts) 的 HTTP 写门在模式非 `serving` 时以 503 拒绝变更请求，写纪元越过进程启动基线后以 `stale-epoch` 拒绝。写者静止要求每个 active 或 draining 节点在当前纪元有新鲜心跳；从未心跳的节点不可能在写，心跳过期的节点保持未静止，直到操作员声明 `offline`。恢复心跳的节点回到 `active`，因为 offline 声明为时过早。

独立应用器 `pnpm pg:deploy`（[scripts/deploy-apply.ts](../../../../gateway/scripts/deploy-apply.ts)）在服务进程之外执行受控序列：status、维护进入/退出、静止下应用迁移、备份（转储加受管文件快照，验证并登记）、恢复、滚动重启计划。管理员通过 `/admin/api/deployment*` 和管理端 Deployment 页驱动同一服务；管理端发起的待处理恢复请求由应用器认领而非内联执行。受管文件以路径、大小、sha256 清单随行；任何文件落盘前校验全部摘要，每个文件经同目录 rename 原子就位。

`pg_restore --clean` 会把 `cluster_control` 一并回滚，抹去打开的 `restoring` 窗口。应用器在转储应用后调用 `resumeRestoring`，`completeRestore` 再以 `GREATEST(write_epoch + 1, now)` 推进写纪元——无论行被回滚成什么值，围栏都保持单调。

## 备选方案

**转储与恢复时排除控制面表。** `pg_restore` 没有 `--exclude-table`，且 `--clean` 按转储顺序删约束：被排除在转储之外的存活控制表仍持有外键，会阻断恢复中的 `DROP CONSTRAINT organizations_pkey`。把表留在转储内、事后重新断言窗口，对新旧转储都成立。

**让每个写者轮询维护状态自行停写。** 休眠或网络分区的节点会越过窗口继续写。写门必须在服务端拒绝写入，纪元确认也让沉默节点的状态可见，而不是被当作已排空。

**受管文件随转储尽力恢复。** 摘要校验在复制中途失败会留下半恢复部署。首个复制前校验整个清单，让文件集恢复要么全部要么没有。

## 影响

写门给每个变更请求增加一次控制行读取；维护期间读取与部署控制路由保持开放。恢复把集群停在维护态等待操作员验证，而不是自动重开。备份仅在转储验证后登记，失败的转储不会产生可恢复记录。台账在恢复时随数据库回滚；新的 `restore` 操作行仍记录切换发生。PostgreSQL 测试覆盖窗口转换、心跳复活、待认领顺序、备份登记与控制行回滚；HTTP 套件覆盖写门与管理端路由。
