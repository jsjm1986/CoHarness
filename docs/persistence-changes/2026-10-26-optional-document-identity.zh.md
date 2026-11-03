---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-26-optional-document-identity

[English](2026-10-26-optional-document-identity.md) | 中文

## 概述

在九个已有会话事件根所保留的 UserDocRef 值中增加可选的文档实例元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-26-optional-document-identity
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-19-fixture-message-source"
    after: "dcedf7a96cc3d58d0a3001dce539a3835d06c9086d866a063b0b6d7ba85ec7c1"
    decision: same-version
  - root: "event:auto-review/request"
    previous: "2026-10-25-codex-native-model-input"
    after: "9f2b11ddeb29ba848535a33a54ec572eca60d65538d41a1862c8344886e443c4"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-10-25-codex-native-model-input"
    after: "af6ee918571c78d55fd34900128dbf535ed254b7bfb61a36695f14814b83d0d0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-19-fixture-message-source"
    after: "4bd538afe289a64b354a9c678e61e5249ff1ab7f8c91cc949fb450eb2c1f2207"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-10-25-codex-native-model-input"
    after: "bc58adc1207058cdc18c3155dd57173917ba7b97ca00791117f20a57af9f545b"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-10-25-codex-native-model-input"
    after: "0f63e4e5f609d6318d1797ad0af2493c4ae3265f8833263005037d14fa80c070"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-19-fixture-message-source"
    after: "a4036ca87bc3831360c19754075a79702874caa46e76ec42d48ad99defe854c2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-19-fixture-message-source"
    after: "bdfeb66094a5f96e7157fe586dc9c416f7633d313e47156d32913df0876acb2d"
    decision: same-version
  - root: "event:userdoc/attached"
    previous: "2026-09-18-coharness"
    after: "7578271fabb3d5d4bcae41075cf1a5a901c4fe4f6e517c9c01caf971b4cb41de"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

identity 属性是可选的。已有文档引用可省略它并继续有效；新引用可以将实例 id、修订号、发布者和来源保留为 JSON 元数据。此字段不替代文档路径、冻结的提示表示或当前访问检查，也不授予权限。不读取 identity 的消费方保留现有文档呈现。没有新增必需字段、事件名称或 SessionHeader.version，因此这项可选增加沿用现有格式版本，无需改写任何已提交文件代际。

<a id="verification"></a>
## 验证

文档上下文与存储约定的针对性检查有 27 个测试通过。省略或包含 identity 的元数据都可经过 JSON 序列化和会话回放，并生成相同的冻结模型文本。见[已执行检查](../../.agents/audits/receipts/document-optional-identity-persistence-compatibility.json)。这些证据只验证元数据兼容性，不代表跨账号文档授权已接通。

<a id="dev-note"></a>
## 开发备注

无。
