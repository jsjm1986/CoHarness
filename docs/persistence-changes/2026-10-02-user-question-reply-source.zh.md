---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-02-user-question-reply-source

[English](2026-10-02-user-question-reply-source.md) | 中文

## 概述

确认 agent/inbox/spliced 插入行、developer/message、session/title-llm-request 与 user/message 中 user/developer 消息 `source` 联合新增的消息来源种类 `user-question-reply`：dsh-user-questions 在定时问题结束时把迟到回复导回 agent 时盖上该标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-user-question-reply-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-30-captured-format-version"
    after: "97bcf76a5e61136e96f0013f0d1a09a0892eaab1e7797db9b58243fbcacd3cfa"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-captured-format-version"
    after: "0ea329a64267fcf5aed9961cbc1c50f75c0ac24796e678a8242fda19a2776b0e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-captured-format-version"
    after: "5995b6bc4cf7d474f141d007bf2969e2a1a15370a25c3a78110f1d5f3c867133"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-captured-format-version"
    after: "62fdd3262120f81c5cdf05e52dfc5c11d618b301c64d807e799fb8d11174cf77"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该种类声明为 `@persistenceAttribution`，记录的 source 策略允许它在不提升版本的情况下加入：它只标识产出一条本就会被保留的消息的插件，不新增必填字段，也不给读取方增加义务。不识别该产出方的读取方按未知来源保留规则保留消息与其未知 kind，与同一联合上其他 attribution 种类一致。

<a id="verification"></a>
## 验证

scripts/persistence-changes.ts 依据记录的 source 策略将四个根均归类为 attribution-kind-added；packages/interaction/user-questions 的 spec 覆盖产出方写入 `user-question-reply` 的 `callId` 与 `outcome`，Session projection 读取该 kind 以关闭已结束的问题。

<a id="dev-note"></a>
## 开发备注

无。
