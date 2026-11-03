# Agent Note: 归档记录在 Runtime 命名空间内保持稳定身份

Status: implemented

[English](2026-10-30-archive-runtime-namespace.md) | 中文

## Problem

Host Session 标识只在 Runtime 内有效。共享 Gateway 数据库和管理员阅读器需要区分相同的 Host ID，同时保留日志且不允许其他 Runtime 认领数据。只使用根标识还会把搜索、待处理命令、文件清理和浏览器选择关联到错误记录。

## Decision

每份归档具有带品牌类型的不透明 UUID `archiveId`。PostgreSQL 只分配一次，并保留组织／Runtime／Host 根会话的唯一组合。搜索、命令与文件清理任务引用归档；搜索事件身份还包含 Runtime。迁移保留已记录分配及未分配历史，创建 Runtime 不能接管未分配的归档数据。

管理员读写使用[按记录寻址的 API](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/archive-administration-authority/guide.zh.md)。原始 Host 根仍作为 Runtime 读取和命令参数。Session 回退读取与破坏性 SQL 必须匹配归档记录的 Runtime；未分配的旧记录还要求匹配其已记录项目或个人创建者。浏览器选择、轮询、详情响应和导出使用不透明归档身份。幂等重试仍保留所选电脑与当前管理员资格。

草稿预留使用已有的规范 Session 校验生命周期，并在预留行之前锁定其根会话。归档根会话需要明确恢复后才能获得预留；预留被并发释放时需要重新请求。空白草稿清理同时检查恢复时间和 Session 活动，保留管理员刚恢复的工作，直到其满足已确认的截止时间。

## Alternatives considered

**改写 Host ID 或 Session 日志。** 拒绝：Runtime 本地日志和不可变代次保留生产者身份。

**将组织内相同 Host ID 视为归属证明。** 拒绝：独立复制或生成的历史可能共用标识。名称相同不能授权读取、重新分配或删除其他 Runtime 的数据。

## Consequences

自定义管理员客户端与 Gateway 和内置界面一起升级。旧根会话路由直接拒绝，不将 Host UUID 当作归档 UUID。Runtime 快照与命令仍保留 Host ID。迁移保真、同 Runtime 并发投影、跨 Runtime 同名操作、浏览器迟到响应及清理隔离需要真实数据库和装配后 HTTP 验证。逻辑电脑夹具不能证明物理多机启动或模型提供商验收。
