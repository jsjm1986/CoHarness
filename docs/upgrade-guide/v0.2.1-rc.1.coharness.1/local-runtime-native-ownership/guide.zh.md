---
kind: upgrade-guide
description: "Linux 本地 Runtime 分配会保留原生子进程 scope，直到所有后代均退出。"
---

# 升级本地 Runtime 后代所有权

[English](guide.md) | 中文

## 变化

Linux 用户级 systemd 管理器可用时，新本地分配会在私有所有权预留中记录 `nativeRange=linux-slice`。Runtime、探测 scope、pipe 与 PTY scope、SDK 子进程及其后代均保留在该 nonce 专属的 slice 中。容量释放要求整个范围为空。用户级管理器不可用时保留不确定占用；管理器恢复可用后可继续清理。监督进程失效后，恢复控制器可停止精确 slice，无需向从磁盘读取的数字 PID 发送信号。

macOS、用户级管理器不可用的 Linux，以及已有进程组分配，保留已记录的 POSIX 进程组保证。原生所有权不会增加文件系统隔离。已发布 Session 代际和 PostgreSQL 数据库结构不变。

后备 POSIX 终端清理会拒绝不完整或未经确认的进程表观察，并保留已知后代身份，包括根进程退出之后。先恢复进程表访问，再重试清理，然后才可回收容量。自定义 POSIX 检查器仅在进程表读取完整时声明 `complete: true`。Windows 直接检查各进程身份，并拒绝身份不可读或进程枚举失败；恢复查询权限后再重试清理。参见[观察决策](../../../../.agents/notes/implemented/bug-fix/2026-10-29-incomplete-process-group-observation.zh.md)。

## 迁移

1. 一同升级 Gateway、受管电脑进程及匹配的本地子进程提供方。保留节点本地控制记录与锁。旧控制读取者会拒绝原生所有权元数据，无法恢复这些分配。
2. 通过原所有者排空已有本地分配。回收不确定容量前，独立确认逃离进程组的后代均已停止。升级后重新启动分配；修改保存的记录无法为运行中的进程增加原生约束。
3. 在用户级管理器可用的 Linux 主机上构建工作区消费者，再从 `gateway/` 执行 `npm run test:built-local-native-supervision`。无密钥场景使用编译 Gateway、真实 Loader、pipe、PTY 与 SDK 进程启动器。验证 Gateway 故障恢复、后代存活期间保留占用、所有者失效后的清理，以及独立分配之间的隔离。参见[监督决策](../../../../.agents/notes/implemented/architecture/2026-10-25-local-runtime-supervisor.zh.md)。
