# Agent Note: 删除时仅清空可空的归档引用

Status: implemented

[English](2026-10-04-archive-nullable-reference-deletion.md) | 中文

## 问题

已发布且不可变的迁移 `015` 定义了五个归档复合外键，未指定列清单的 `SET NULL` 也会清空不可空的 `organization_id`。在这些定义下，对含有归档的项目执行真实的 `PostgresProjectService.remove`，或物理删除 fixture（测试前置数据）用户时，PostgreSQL 都会报 `23502`。

## 决策

单调递增的迁移 `050` 重新添加同样的五个外键，保留原有列与约束名。它保留完整的复合组织检查，并明确只将 `project_id` 或对应的可空用户引用列置为 NULL。组织、根会话与运行时身份保持不变。

这不承诺项目删除后 transcript（文本记录）仍然存在。生产环境中的用户移除仍为逻辑移除，而不是物理删除。

组织与 `publicId` 规则仍由独立的 [PostgreSQL 基线及运行时切换架构](../architecture/2026-08-14-postgresql-jsonb-gateway-baseline.zh.md)负责。

## 考虑过的替代方案

**修改已发布的迁移 `015`。** 已部署迁移的校验和将不再匹配。

**从外键中移除组织列。** 这会削弱跨组织引用检查。

**在管理员包装层中解除归档元数据引用。** 其他删除调用方仍然会触发有缺陷的外键。

## 后果

归档引用可以被清空，同时不违反组织身份要求，也不削弱复合外键检查。现有部署通过单调递增迁移获得修正，已发布迁移的校验和不变。

## 验证

[管理员业务 PostgreSQL 规格](../../../../gateway/tests/admin-business-postgres.spec.ts)与 [PostgreSQL 规格](../../../../gateway/tests/postgres.spec.ts)验证真实服务的项目删除、fixture 用户物理删除、组织保留、操作者引用清空、以 `23503` 拒绝外组织引用，以及旧迁移升级与幂等性。
