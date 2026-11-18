---
kind: upgrade-guide
description: "新会话写入 v7 格式;早于本版本的构建拒绝打开它们。"
---

# Session 日志格式 v7

[English](guide.md) | 中文

## 变更

Session 写入器现在产出格式版本 7。读取器在打开时把每个已提交的更早代际(v0–v6)向前迁移,既有会话升级后照常可用。反方向则拒绝:早于本版本的构建打开 v7 Session 文件时,识别其版本高于自身写入器并以 `SessionFormatUnsupportedMigrationError` 失败,绝不加载部分状态。旧版本已提交的会话文件从不移动、覆写或删除——每个代际都与后续代际并存。

## 迁移

1. 在运行本版本之前,先升级所有读取共享 Session 存储的部署与工作站;一旦产生 v7 会话,旧构建将无法再打开它。
2. 如需回滚,让旧构建读取升级前最后写入的会话数据;或在新构建尚能打开全部数据时先导出所需内容(会话 ZIP 导出)。
3. 确认会话可打开:`dsh session list` 对升级前后记录的会话均不抛出 `SessionFormatUnsupportedMigrationError`。
