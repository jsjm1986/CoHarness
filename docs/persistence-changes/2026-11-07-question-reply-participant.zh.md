---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-question-reply-participant

[English](2026-11-07-question-reply-participant.md) | 中文

## 概述

在携带消息的事件中为 `user-question-reply` 来源增加可选的已认证项目回复者快照。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-question-reply-participant
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-26-optional-document-identity"
    after: "ecf257032ed7572a2924d5e51563291ea747126ef67a31a8bd01bcb55df23069"
    decision: same-version
  - root: "event:auto-review/request"
    previous: "2026-10-26-optional-document-identity"
    after: "9dd0d4f8c2e191ad03f26546d0ce33e200e5cf3a39a427fa6590188144012cf5"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-10-26-optional-document-identity"
    after: "dc27ced3b2ec97a30f6b2c5d49283f6d8995fb298816e7088cda8c25bf5a2adc"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-26-optional-document-identity"
    after: "836ff5b62e772454aefff1488eed3f2c70201af7616011f3b7f1296541f4878b"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-10-26-optional-document-identity"
    after: "95254a03cc8e177f2f1f23b4446787ee30bb8dadfa4326bdb5c100667f4a6b8d"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-10-26-optional-document-identity"
    after: "64c8cf181bbbc3100fdf035e272b719730956283575f3176857620f6cdae0e9c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-26-optional-document-identity"
    after: "0a11a719796bd044860a3162d2fdeef5d872433f7d8d4487d7103b2098b03bd1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-26-optional-document-identity"
    after: "cf1c6bdfb570103bd62e2c51cbd550642a5c65244cf3ffca3ed7c22839eaaa8a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。该字段为可选，缺少它的旧记录回放不变；不识别该字段的读取方忽略它，投影仍可在无快照时归属回复。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/interaction/user-questions：覆盖回复持久化；变更前写入的记录不含 participant，反序列化结果相同。

<a id="dev-note"></a>
## 开发备注

无。
