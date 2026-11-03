# Agent Note: PostgreSQL 命令环境

Status: implemented

[English](2026-10-31-postgres-command-environment.md) | 中文

## Problem

备份、归档检查、SQL 生成和恢复会执行 PostgreSQL 工具或已配置的命令封装。完整继承进程环境会把数据库操作不需要的 Gateway 配置、Runtime 设置和提供方凭据交给这些子进程。

## Decision

这四条命令路径均使用既有的 Gateway 工具环境清理规则。PostgreSQL 已配置的密码、密码文件和 SSL 私钥输入通过 `PGPASSWORD`、`PGPASSFILE` 和 `PGSSLKEY` 作为显式例外保留；未配置时仍保持缺省。共享规则保留的其他 PostgreSQL 连接设置继续可用。显式数据库参数和进程关闭归属维持既有行为。

## Alternatives considered

**移除全部凭据类变量。** 原生 PostgreSQL 客户端可能依赖已配置的密码文件或客户端证书私钥；移除这些输入会破坏需要认证的维护操作。

**为可信命令封装保留完整继承。** 封装程序有权访问所选数据库，并不意味着它需要模型密钥或其他 Gateway 权限。

## Consequences

自定义封装使用数据库参数和 PostgreSQL 配置，不再依赖其他 Harness 变量。无需密钥的源码及编译命令回放，分别在配置和不配置合成数据库凭据时检查四类真实子进程调用。独立的真实 PostgreSQL 备份和恢复套件验证数据库兼容性。这项环境规则不改变既有的数据库参数传递方式。
