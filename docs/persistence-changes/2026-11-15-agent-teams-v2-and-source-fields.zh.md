---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-15-agent-teams-v2-and-source-fields

[English](2026-11-15-agent-teams-v2-and-source-fields.md) | 中文

## 概述

吸收 Agent Teams v2：Team 事件负载变为版本化联合体（v1 仅解码、v2 写入），新增 `team/mode` 根事件记录用户选择的 Team 模式，`team/task` 新增可选 `ownerName`，`skill-catalog`/`subagent-settled` 消息来源新增可选 `incomplete`/`stopReason` 字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-15-agent-teams-v2-and-source-fields
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-managed-prompt-receipts-and-reply-participants"
    after: "ddd1a1b73e3bb59a51e520c065af3921686690bf5ebe197ba45ebcab22fc9325"
    decision: same-version
  - root: "event:auto-review/request"
    previous: "2026-11-05-managed-prompt-receipts-and-reply-participants"
    after: "a3ba8532e89044f88bc8c8ff14c89c3a22b66a91f95c6560a9a91d90f48ce8bc"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-11-05-managed-prompt-receipts-and-reply-participants"
    after: "eba54b9c905635921ff042f038f5d785103a70cd00008d9ae9987d029bf0f37a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-managed-prompt-receipts-and-reply-participants"
    after: "923082ef7aac0c45c346000507fb553661a315847ea2714a5dba9916077ef861"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-11-05-managed-prompt-receipts-and-reply-participants"
    after: "5f1011f486a580ddebcfbd5527709c5a170b45949b3702ee09436ffa51c434d4"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-11-05-managed-prompt-receipts-and-reply-participants"
    after: "b06ffd4a49b4413fc20ed5adc8571fae2a23c5afdaa9a86fa7b2a49150af1904"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-managed-prompt-receipts-and-reply-participants"
    after: "307128c5248f1de074283c8a6d204dd619fea1c6ae75cb22da1276ab6213f4ec"
    decision: same-version
  - root: "event:subagent/catalog"
    previous: "2026-10-18-rc2-catalog-and-ptc-metadata"
    after: "d49164d37eab0f0f70fa787c65d887abbea869c010ccb103d717fab3519c3a41"
    decision: same-version
  - root: "event:team/member"
    previous: "2026-10-11-team-member-model"
    after: "c59e9ec33888dc9b3df2c2e19e7bc30c633c0374f8bd02212f02bf27334dc8ba"
    decision: same-version
  - root: "event:team/message/delivered"
    previous: "2026-09-18-coharness"
    after: "a10ad2c2164a460e57640b44cbd0c273949c5ce2e4367608b86d786960a559c4"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-30-v7-tool-result"
    after: "d15f2cd6c9e9d47b3f61ee12589d1e78b423025f7710d502b53a9ab851e42280"
    decision: same-version
  - root: "event:team/mode"
    previous: null
    after: "920d87e22b7409bcc7224f8b1dc7f5101c33574c75627c65baab12b85cc96e75"
    decision: same-version
  - root: "event:team/task"
    previous: "2026-09-18-coharness"
    after: "c59b5582f29da74be8f8b8c197ba687b71dd71377f6c9b32935c2ac3e85b279c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-managed-prompt-receipts-and-reply-participants"
    after: "7e45253c0768755d6f002ce34a50b216033613bbb5923c5983e49e366b6a8089"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

全部变更在同一 Session 格式版本内读取兼容。`team/task` 负载从 version-1 对象扩为 v1|v2 联合体，已发布 v1 成员结构保持不变；已发布日志按 v1 变体解码，当前写入器只产出 v2。`team/member`、`team/message/queued`、`team/message/delivered`、`subagent/catalog` 的负载版本标记遵循相同的仅解码 v1 约定。`team/mode` 是仅由知情构建读取的新根事件。`ownerName`、`incomplete`、`stopReason` 均为历史记录中不存在的可选属性。不重写任何已提交代际。

<a id="verification"></a>
## 验证

本记录落盘后 pnpm run verify-persistence-changes 无未确认差异；agent-team 与 session-format 套件原样重放 v1 记录。

<a id="dev-note"></a>
## 开发备注

无。
