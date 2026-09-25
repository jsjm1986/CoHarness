# Agent Note：按作用域配置 Subagent 设置

Status: implemented

[English](2026-09-23-scoped-subagent-limits.md) | 中文

## 问题

Host 通过设置提供委派限制，但缺少配置卡片会让远程用户无法操作。将整个设置分节开放给项目管理者，又会同时授予部署专属的持续激活预算修改权。

## 决策

[Subagent 设置卡片](../../../../packages/client/ui-settings-plugins/src/client/SubagentLimitsCard.tsx)将 alpha.2 的限制控制器和字段适配到现有账户／项目插件分区。整数校验、独立重置、零深度行为、后代容量和可展开帮助遵循上游。现有本地卡片负责暂存保存和项目所有者说明；帮助操作使用本地问号图标。

[Host 注册](../../../../packages/subagent/subagent/src/index.ts)声明项目归属，并将管理者写入限制在 `maxDepth` 和 `maxActiveSubagents`。现有 API proxy 强制这些路径、拒绝其他成员并禁止整节替换。项目不能编辑部署专属的持续激活预算。不引入新的设置存储或写入者。

## 考虑过的替代方案

**仅保留文件配置。** 已有设置服务拥有这项获批运行时功能，仅靠文件会使远程操作者无法使用。

**整个命名空间均允许项目写入。** 本地持续激活预算属于不同的所有者；字段授权保留这一差别，无需复制 schema。

## 后果

本机操作者和获权项目管理者可通过同一运行时服务配置委派。深度作用于后续委派尝试，不取消已有子 Agent。根容量保留服务的存活计数语义。独立的模型选择命名空间复用上游路由控制器与字段，接入同一套本地命名空间卡片。项目管理者仅可修改 `enabled` 与 `allowedModels`。Host scope 通过现有队列和 describe 镜像提供原子、固定 revision 的 mutation；账户 transport 保留标量写入。开关与精确路由同时提交，陈旧草稿会被拒绝，已下线路由仍可移除，重连会丢弃目标专属草稿。目录或写入 transport 失败保留可重试的用户状态。这些偏好不替代运行时模型治理。测试覆盖真实 Host 注册和 RPC 授权、浏览器持久化、字段校验及只读控件。
