---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-working-directory

[English](2026-10-13-working-directory.md) | 中文

## 概述

增加每个 Session 的持久化工作目录变更及其通知归因。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-working-directory
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-02-user-question-reply-source"
    after: "d3d3ece359c924faaaa00445c170550729b09b83517903dd33991a04d3e5ebdd"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-02-user-question-reply-source"
    after: "9c8372b22163d4db606bc76654a01fff0583456f25ec761ee03cec458fd43913"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-02-user-question-reply-source"
    after: "ef6c23a2eaefc0e77b0b298a4a4a64453ffb3bda4ed0d452836caad37e9a8633"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-02-user-question-reply-source"
    after: "1ff5d27bf6fa121a02328d9748bafc6a7cfa44f30dd336062ea6468a368a8751"
    decision: same-version
  - root: "event:working-directory/change"
    previous: null
    after: "124aa62078ca3311353b39cc3bf6c75da281338be6bbf672f8b361d828cddca3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Session header 和事件继续有效。新事件在读取时为必需：不认识 working-directory/change 的旧版本拒绝包含它的日志。新增的 working-directory 来源类别仅用于归因；已声明的来源策略保留未知归因而不作解释。事件词汇扩展不改变 Session 的结构格式。

<a id="verification"></a>
## 验证

工作目录与系统提示词套件覆盖持久变更、恢复、用户上下文通知、准入刷新以及受抑制上下文保留；无密钥 headless 回放验证面向模型的上下文行。

<a id="dev-note"></a>
## 开发备注

无。
