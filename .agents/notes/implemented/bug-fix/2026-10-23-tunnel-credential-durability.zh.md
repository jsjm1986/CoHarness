# Agent Note: 保证隧道凭据加密与恢复的完整性

Status: implemented

[English](2026-10-23-tunnel-credential-durability.md) | 中文

## Problem

命名隧道需要在数据库恢复后仍可解密的 Cloudflare 凭据。加密器在完成加密前读取 AES-GCM 认证标签，导致每次真实加密都失败。编排测试用编码替身替代了加密器。受管数据收集器也遗漏了独立配置的隧道密钥，因此数据库转储可能保留密文却没有对应的解密材料。

## Decision

[TunnelCredentialCipher](../../../../gateway/src/postgres/tunnel-access-service.ts) 完成密文生成后才读取认证标签。持久化字节顺序仍为 nonce、认证标签、密文，附加认证数据将每个秘密绑定到其组织、节点与凭据字段。真实加密测试覆盖往返、字节篡改、错误密钥与跨上下文复用；命名隧道配置测试也使用真实加密器，外部 Cloudflare 与进程操作仍通过注入提供。

[部署数据选择](../../../../gateway/src/postgres/deployment-data.ts) 将 `HGW_TUNNEL_CREDENTIAL_KEY_FILE` 登记为独立的 `gateway-tunnel-credentials` 文件根，包含自定义位置。其字节随选中的数据库快照恢复，不随当前节点配置保留。恢复预览拒绝记录的密钥位置与已配置目标不同的备份。凭据位置搬迁将此文件纳入字节核验。[托管隧道生命周期](../feature/2026-10-18-admin-managed-public-access-tunnel.zh.md)与[协调恢复](../architecture/2026-09-25-gateway-deployment-maintenance.zh.md)保留现有的所有权与维护规则。

## Alternatives considered

**只用假加密器测试编排。** 编码替身不能证明原生 AES-GCM 能够完成，也不能证明持久化字节能够通过认证。外部 Cloudflare 与进程操作仍通过注入提供，加密操作则使用真实实现。

**恢复时保留当前密钥。** 恢复的数据库密文属于选中快照的密钥。保留独立替换过的当前密钥会让恢复的凭据无法读取，因此密钥与其密文同属应用数据。

**归档整个 Gateway 状态目录。** 这会捕获未认领的文件，并让备份覆盖范围依赖目录布局。显式文件根能覆盖自定义密钥位置，无须扩大所有权。

## Consequences

密文表示和数据库 schema 保持不变。完整备份包含隧道密钥并验证复制的字节；恢复要求配置位置一致，否则需要显式迁移。未包含密钥的旧备份无法重建缺失的秘密材料。单元测试在无数据库条件下执行真实文件收集、快照与恢复，PostgreSQL 备份案例则同时捕获自定义密钥与已存储的隧道令牌。真实 Cloudflare 配置不在这些确定性测试的覆盖范围内。
