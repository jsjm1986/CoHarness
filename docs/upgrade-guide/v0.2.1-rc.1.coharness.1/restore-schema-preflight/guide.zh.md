---
kind: upgrade-guide
description: 协调恢复在进入恢复窗口前拒绝迁移版本、名称或校验和不同的备份。
---
# 恢复 schema 资格

[English](guide.md) | 中文

## 变更

来自不同 schema 的已验证备份可能先进入 `restoring`，随后才在 SQL 替换时失败。恢复登记会在备份记录的迁移版本与目标不同时返回409 `backup-schema-version-mismatch`。独立应用器还会在创建保护备份或进入 `restoring` 前，比较归档实际迁移的版本、名称和 SHA-256 校验和。这同时适用于已登记备份和直接 `--dump` 输入。不一致会以 `backup-schema-differs-from-destination` 失败，并保持维护模式。

配置的恢复客户端必须将迁移表输出为规范文本 `COPY` 数据。缺失、不完整或不受支持的元数据（包括 INSERT 格式迁移导出）会以 `backup-schema-metadata-unreadable` 失败。检查期间不执行归档 SQL。元数据匹配也不能免除现有归属与受管文件检查。

## 迁移

1. 选择与目标迁移集合完全相同的已验证完整备份。Admin 恢复请求检查记录的版本；应用器在继续前检查实际转储。
2. 保留较旧 schema 的归档用于隔离恢复。不要编辑迁移记录，让不兼容归档看似具备恢复资格。参见[维护决策](../../../../.agents/notes/implemented/architecture/2026-09-25-gateway-deployment-maintenance.zh.md)。
3. 使用 Gateway 维护流程正常产生的自定义格式备份。自定义 `HGW_PGRESTORE_COMMAND` 包装器必须支持将 `harness.schema_migrations` 的离线纯数据输出写至 stdout。
4. 确认不兼容尝试保持部署处于维护状态，且没有新增保护备份。已打开的 `restoring` 窗口仍绑定其登记目标和保护副本；此检查不会清除该窗口，也不授予切换目标的权限。
