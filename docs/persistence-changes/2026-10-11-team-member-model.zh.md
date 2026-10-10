---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-11-team-member-model

[English](2026-10-11-team-member-model.md) | 中文

## 概述

确认 `team/member` 的 `data.member` 新增可选 `model`：激活时把成员解析出的请求路由持久化，使未运行名册行在 Agent 销毁后仍显示成员各自的模型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-11-team-member-model
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-18-coharness"
    after: "61e2ba55405ca7ede6bb6bc4c47af5348fefd1b8c5f0ab20e0a4b7d5f22bc447"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

同版本：`model` 双向可选。该字段存在之前激活的成员与仍在供应中的成员都省略它；读取方对这些快照照常折叠。

<a id="verification"></a>
## 验证

`pnpm run verify-persistence-changes` 将该差异分类为 `optional property added (same-version allowed)`；Agent Team spec 覆盖激活持久化、未运行行展示与旧快照兼容。

<a id="dev-note"></a>
## 开发备注

无。
