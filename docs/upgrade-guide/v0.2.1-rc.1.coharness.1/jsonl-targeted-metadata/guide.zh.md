---
kind: upgrade-guide
description: "JSONL 元数据读取会传播选定产物的代次与身份拒绝，而不再通过会话列表过滤该产物。"
---

# JSONL 单会话元数据拒绝

[English](guide.md) | 中文

## 变更

`dsh-session-persistence-jsonl` 通过单目标 `stat(id)` 操作实现 `readHeader(id)`、`revision(id)` 和 `readRevision(id)`。这些读取此前继承完整列表回退，可能省略不受支持的产物。现在它们与 `stat` 一样，原样传播所选产物的代次、身份、编码和解码错误。缺失会话仍返回 `undefined`；最高代次不受支持时绝不回退到旧文件。元数据读取不检查事件正文，也不更改已提交文件。

## 迁移

1. 自定义持久化消费者必须像处理 `stat` 拒绝一样，处理这三个方法的拒绝。将 `undefined` 视为不存在，并保留拒绝，不要在不可读产物之上创建替代会话。
2. 保持配置的 JSONL 压缩模式与根目录一致。目标采用更新格式时，使用支持该代次的版本读取；不要通过重命名或删除已提交代次强迫旧读取器接受它。
3. 在隔离副本中确认：有效 id 返回元数据，缺失 id 返回 `undefined`，不受支持的目标拒绝且其文件不变。无需 schema 迁移、配置变更或日志重写。[包参考](../../../../packages/session/session-persistence-jsonl/README.zh.md#durability-and-crash-semantics)说明查找与取消行为。
