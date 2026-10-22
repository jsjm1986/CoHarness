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
    previous: "2026-10-17-memory-recall-source"
    after: "ca3082f98a92e7e28c5b50718c8e17285bf020e33c63c8489a4eac05ca7d6fc2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-memory-recall-source"
    after: "be178e721e3554ed94b1988b892f45a66d575d339518f0aa3d5ee3a8e80584ff"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-18-title-reasoning-effort"
    after: "1ade73d8d275f25066d9b0ecd5d97563757021a0ab32cb20a436ef2b5a4aca8f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-memory-recall-source"
    after: "081d62847eea7c2011b66be579949cd4fda0a6be75f3f566fc52c69ffc9e9e71"
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
