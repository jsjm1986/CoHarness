# Agent Note: Gateway 启动韧性

Status: implemented

[English](2026-08-18-gateway-startup-resilience.md) | 中文

## 问题

macOS Gateway 可能在 PostgreSQL 容器仍在启动或短暂不可用时被拉起。立即启动失败会让 launchd 反复重试整个进程，制造大量日志，并让恢复依赖时序。正常 Gateway 停止也可能在本地运行时子进程仍存活时被强制结束，使旧运行时继续占用端口，而替换后的 Gateway 已经启动。

## 决策

Gateway 启动只对暂时性的 PostgreSQL 连接和服务器不可用错误采用可配置的有界指数退避。凭据错误、migration 校验差异和未激活的企业记录仍然立即失败。重试循环支持在 supervisor 替换进程时中止，诊断日志只记录数据库错误码，不记录连接 URL。

本地启动器把每个子运行时登记到进程级退出清理集合。同步的进程退出处理器会向仍在运行的本地子进程发送 `SIGKILL`，因此 Gateway 被强制停止时不会留下继续占用分配端口的旧运行时。受控 release 部署还会把 Gateway 与子进程命令固定到同一个不可变 release，并在激活前验证新进程。

## 验证

数据库重试测试覆盖瞬时故障恢复、有界延迟、包装错误、非瞬时错误快速失败、诊断脱敏和 supervisor 中止。Gateway 配置测试覆盖重试默认值、覆盖项和无效窗口。现有 release-control 测试覆盖不可变 release 启动、激活回滚和拒绝清理仍被旧运行时使用的 release。

## 曾考虑的替代方案

**重试所有启动错误。** 否决，因为凭据错误、migration 漂移和未激活的部署记录需要立即让运维看到，而不是无限等待。

**把全部数据库重试交给 launchd。** 否决，因为 Gateway 会留下平台特定的启动行为，也无法区分 PostgreSQL 瞬时故障与无效配置。

**只依赖停止阶段的 `stopAll()` 优雅清理。** 否决，因为强制退出、拆卸期间崩溃和 supervisor 截止时间都可能绕过异步清理路径；本地子进程必须有进程退出兜底。

## 后果

PostgreSQL 不可用时，Gateway 会保持端口未绑定，直到依赖恢复；因此 `/healthz` 不会虚假地报告健康，而是不可访问。运维仍必须监督 PostgreSQL 容器，并在 Docker 或主机恢复后等待其就绪。本地运行时子进程在进程退出时终止，systemd 管理的运行时继续由其现有 supervisor 负责生命周期。
