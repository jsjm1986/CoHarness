---
kind: upgrade-guide
description: 可选 SQLite Session 存储拒绝创建绑定受管 SSH 目标的 Session。
---
# 受管 SSH 目标与 SQLite Session 存储

[English](guide.md) | 中文

## 变更

可选 SQLite Session 存储没有受管 SSH 目标字段。创建绑定这类目标的 Session 时，会在会话可执行或重开前拒绝该会话头。

## 迁移

1. 保留已有 SQLite 文件供本机会话使用。旧记录缺少目标字段时，无法从该记录确定原 SSH 主机。
2. 用部署中的 JSONL 或 Gateway 持久化创建新的绑定 SSH 的 Session。重新打开 Session 后核对所选目标。
