---
kind: upgrade-guide
description: "Webhook 管理保留当前管理员资格，投递预留绑定当前端点版本。"
---

# 升级 Webhook 准入资格

[English](guide.md) | 中文

## Change

Webhook 端点写入、特权元数据读取和手动重新派发在数据库工作期间保留当前有效管理员。管理员资格撤销后返回403，不产生成功修改审计或新的派发回执。

提供方预留要求企业有效，且端点仍启用并保持签名验证时的版本。端点移除或停用返回404；配置变化返回409。拒绝的预留不消耗接收额度。无法在 JSON 序列化中保留的解析载荷值，在回执创建前返回400。管理员显式重放可以使用已停用端点的当前配置，而不会启用公开接收。

## Migration

1. 升级完整 Gateway。请求 JSON 和数据库 schema 无需迁移。
2. 自定义端点服务为 `list`、`update`、`mutate` 和 `dispatchConfig` 接收认证管理员 id；回执诊断和重新派发也传递该 id。同步更新所有调用方。
3. 直接预留调用方先注册并启用真实端点，再传入当前版本、执行账户和目标。轮换后保留原回执；使用当前端点配置重试传输。见[准入决策](../../../../.agents/notes/implemented/bug-fix/2026-10-29-webhook-admission-authority.zh.md)。
