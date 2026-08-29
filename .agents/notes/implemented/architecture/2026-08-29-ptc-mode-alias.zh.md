# Agent Note: 接受 PTC 作为工具呈现的规范名称

Status: implemented

[English](2026-08-29-ptc-mode-alias.md) | 中文

## 问题

上游把程序化工具调用呈现称为 PTC mode，而现有 profile 与会话历史使用 Code mode。直接重命名会让已部署的 patch 和回放配置失效。

## 决策

工具呈现 schema 接受 `native`、`ptc`、`code` 和 `both`。`ptc` 是 schema 规范化后的名称；`code` 保留为输入别名。运行时与 scoped presentation 会把两种写法规范化到现有执行实现，因此直接调用限制和 SDK 行为完全一致。历史名称继续可在文档和已存储会话数据中读取。

## 备选方案

**立即移除 `code`。** 不予采用：现有 profile、overlay 和客户端会在加载时失败。

**只保留 `code` 并改文档。** 不予采用：新的上游兼容 profile 会被拒绝，调用方也无法使用稳定名称。

**为两种名称运行不同实现。** 不予采用：两条路径可能在 schema 可见性或直接调用强制上产生分歧。

## 影响

新的 profile 输出可以使用 `ptc`，旧的 `code` 输入继续工作。内部只有一条 mode 实现路径，不需要重写 Session 历史。

## 测试

Tool runtime 与 scoped presentation 测试验证 `ptc` schema 接受、规范化，以及与旧写法相同的仅 `run_code` wire 行为。
