---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-deliverables-events

[English](2026-09-23-deliverables-events.md) | 中文

## 概述

新增显式文件交付声明与工作区轮次变化通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-deliverables-events
baseline: false
changes:
  - root: "event:deliverables/presented"
    previous: null
    after: "13d3d180f977bf78081d487ffa0ecb75857349bcab29a5a3fb48189fca2a6176"
    decision: same-version
  - root: "event:workspace/changes"
    previous: null
    after: "e308ccf867a5398e316e0af8cb6ce238a8d33a63b9b384c8250a686786285f72"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新事件沿用现有信封并要求读取端识别。旧日志仍可读取，不认识这些事件的读取端必须拒绝。声明保存路径而非文件内容；变化摘要仅在记录器存活时提供。不修改已有的已提交格式代次。

<a id="verification"></a>
## 验证

V5 事件准入测试通过 22 项，包括文件字节与 inode 不变验证。TypeScript 与 Python SDK 保留两类事件而不混入助手输出。真实 Web 记录器与 Review 场景通过，分别断言历史比较和当前文件。

<a id="dev-note"></a>
## 开发备注

无。
