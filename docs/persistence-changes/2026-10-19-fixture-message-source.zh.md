---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-fixture-message-source

[English](2026-10-19-fixture-message-source.md) | 中文

## 概述

为 user、developer 与 inbox 插入消息的 source 联合类型以及 session/title-llm-request 的 messages 数组新增 fixture 变体，用于浏览器 fixture 会话模式。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-fixture-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-working-directory"
    after: "0d67f2faa274f1e3b3de3912cf334c2339eba8e8390b66dd8ec670da2405c09c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-working-directory"
    after: "43ff3f950db94be7464519e7a18cda3d209c2576ebd1a678162b6afc06cfe5da"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-18-title-reasoning-effort"
    after: "43c60544f929293b6138828ac02928d2714cfb0da033d0f52af7482656135a77"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-working-directory"
    after: "f045679b240795217048f4ffab30175320d9b2af1995cfb05d130b461ba1b82c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录不受影响；该变体是 merge-extensible 联合上的纯增量。fixture 来源的事件只由客户端 fixture 模式产生，不经宿主持久化写入器发出，已发布日志不会携带它们。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/test-support/session-snapshot/tests/suite.spec.ts：152 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
