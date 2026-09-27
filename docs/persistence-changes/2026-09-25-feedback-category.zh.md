---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-25-feedback-category

[English](2026-09-25-feedback-category.md) | 中文

## 概述

为记录的消息反馈新增可选 `category` 成员，使提交在评分与备注之外能够标注作者意图类别。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-25-feedback-category
baseline: false
changes:
  - root: "event:feedback/message-put"
    previous: "2026-09-18-coharness"
    after: "b5086d249e8502e9ead1d39156bb8d559bde7951cac0f14ce150345b4e42a2bf"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

`event:feedback/message-put` 负载在同一格式版本下可携带可选 `category` 字段。早于该成员的读取方仍能通过校验读取旧负载，因为该字段可选且不附带读取义务；未选择类别时写入方省略该字段。已提交的代次不变。

<a id="verification"></a>
## 验证

message-feedback 套件覆盖了仅修改类别的持久化与省略字段时清除已存类别两条路径，持久化变更门禁将此次根转换记录为同版本变更。

<a id="dev-note"></a>
## 开发备注

无。
