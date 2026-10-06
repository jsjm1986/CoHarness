---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-schedule-change-title

[English](2026-10-03-schedule-change-title.md) | 中文

## 概述

确认 `schedule/change` 的 `data.schedule` 新增可选 `title` 属性：计划提醒行在既有的时间与投递字段旁持久化操作者提供的标题。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-schedule-change-title
baseline: false
changes:
  - root: "event:schedule/change"
    previous: "2026-09-18-coharness"
    after: "a0a2e5c42e1c929445ecd1cd70f49be6b66441894ec72c08e8ae332821d4a3cb"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

同版本：`title` 双向可选。读取方通过 `Legacy*ScheduleRecord` 变体继续折叠 `title` 出现前写入的行；无标题的写入方直接省略该属性。

<a id="verification"></a>
## 验证

`pnpm run verify-persistence-changes` 将该差异分类为 `optional property added (same-version allowed)`；schedule 折叠与提醒 specs 覆盖带 `title` 与不带 `title` 的记录。

<a id="dev-note"></a>
## 开发备注

无。
