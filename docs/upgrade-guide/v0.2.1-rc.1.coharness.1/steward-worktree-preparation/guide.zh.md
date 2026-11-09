---
kind: upgrade-guide
description: 管家检出使用经过环境过滤的异步 Git 客户端，并设有准备期限和 Gateway 退出取消。
---
# 有期限的管家工作区准备

[English](guide.md) | 中文

## 变更

管家 worktree 准备异步执行，因此慢速检出不会阻塞 Gateway HTTP 请求。Git 子进程使用 Gateway 工具环境过滤；仓库钩子不能依赖继承的 Gateway、Runtime 或凭据变量。`HGW_STEWARD_PREPARE_TIMEOUT_MS` 设置总准备期限，默认 60000 毫秒。Gateway 退出会在后续项目或 Runtime 工作前取消准备。

已有 `steward-workspace` 分支会被保留，重建工作区从源 `HEAD` 分离检出。其他 Git 失败直接报告，不作为分支冲突重试。失败检出的文件保留供管理员检查；准备不会重置已有 worktree，也不承诺回滚 Git 的部分写入。取消会等待本地子进程提供者管理的 Git 进程组结束，包括普通检出钩子。`HGW_STEWARD_PREPARE_KILL_GRACE_MS` 默认为 1000 毫秒，之后升级终止。隔离遵循提供者的[平台限制](../../../../packages/subprocess/subprocess-local/README.zh.md)；较弱平台上逃逸的后代进程不在此保证范围内。

## 迁移

1. 检查依赖继承 Gateway 凭据的仓库钩子。在 Gateway 引导外显式准备这些步骤；环境过滤属于预期行为。
2. 默认值不适用时，将 `HGW_STEWARD_PREPARE_TIMEOUT_MS` 和 `HGW_STEWARD_PREPARE_KILL_GRACE_MS` 设为不大于 2147483647 的正整数。无效值会使配置加载失败。
3. 检出失败后，检查管家工作区与 Git 错误，保留已有分支提交和部分文件后再重试初始化。不需要数据库迁移。参见[管家决策](../../../../.agents/notes/implemented/feature/2026-10-10-steward-maintenance-space.zh.md)。
