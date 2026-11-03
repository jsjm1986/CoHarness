---
kind: upgrade-guide
description: "PostgreSQL 维护子进程继承数据库设置，不继承其他 Harness 私密配置。"
---

# 升级 PostgreSQL 命令环境继承

[English](guide.md) | 中文

## 变更

备份、校验和恢复子进程不再继承无关的 Gateway、Runtime 或凭据类变量。已配置的 `PGPASSWORD`、`PGPASSFILE` 和 `PGSSLKEY` 输入仍可用于 PostgreSQL 认证；未配置的值仍保持缺省。显式数据库参数维持既有行为。

保留的 stderr 诊断按 UTF-8 字节限制为 8 KiB。超长 ASCII 或多字节输出会截取为完整前缀；刚好达到上限的消息保持完整。

## 操作

重新构建 Gateway。如果自定义 PostgreSQL 命令封装读取无关的 `HGW_*`、`DSH_*` 或模型凭据变量，应改用显式参数和 PostgreSQL 设置。既有数据库数据和备份格式不需要迁移。PostgreSQL 的[连接环境变量文档](https://www.postgresql.org/docs/17/libpq-envars.html)列出了受支持的设置。
