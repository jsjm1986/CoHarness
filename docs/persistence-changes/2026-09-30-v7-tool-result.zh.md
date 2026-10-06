---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-v7-tool-result

[English](2026-09-30-v7-tool-result.md) | 中文

## 概述

将会话存储推进到 V7：消息 `source` 成为记录插件生产者名称的 producer-kind 词汇，`tool/result` 把 `role`、`isError` 与 `toolCallId` 提升到所记录的工具消息本体，内容块联合类型承载 V7 块集合，`developer/message` 加入事件映射，头部以版本 7 重新发布。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-v7-tool-result
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-24-v6-ssh-target"
    after: "7a08afdb5a9102ded1745785ae107a70d66bfd475b8cf0c2cfcb9d3cf531ca12"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "17cca412a54e2dbbf68dab1b758475cb8a7cf49587a12baa281ad50640dd0048"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-21-v4"
    after: "153b841c3c35bc747c310e21aca6aee533814f52096f8e65e9198b72bf5a29d9"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-21-v4"
    after: "eaf72fc58fc3a3e9d7bf5727a2db76f173a7ee3be6789f83f67c4db83396afc2"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-21-v4"
    after: "e2f9a41e0989f54ed8cee80f8db2bcf9d60a5c810dc9d45b83fa050b9dce7602"
    decision: version-bump
  - root: "event:developer/message"
    previous: null
    after: "8b13edeffcf9c5196c51828f56de435a403c0259f32fdacc7803d901e4abccb4"
    decision: version-bump
  - root: "event:request/header"
    previous: "2026-09-21-v4"
    after: "4208123b50df5006b181481ab45fcf1cde807b88d3fd4d340090bc2e202fac41"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "6be2289bd4a263141169e2312135aa301ab4a020cbefb3efd3566dbcedb64a31"
    decision: version-bump
  - root: "event:system/message"
    previous: "2026-09-21-v4"
    after: "69081694be231d56fd9580ba14645fd5e35373202605d5c5c841a9435b5fa3b1"
    decision: version-bump
  - root: "event:team/message/queued"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "f8acbb9e1eacad9eeb67db7bd1aa605911a94981fac4f66d2ce3300eb58f2341"
    decision: version-bump
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-21-v4"
    after: "100f6dca1468538239522cde3533e5bd721d0f1a7b50bea8b0eb533ea6c96163"
    decision: version-bump
  - root: "event:tool/result"
    previous: "2026-09-21-v4"
    after: "7c9f44e90a0058f4cc532ae20dad0c10afa6eba22e70a6c79fc79490bad64397"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-21-v4"
    after: "0f8512903d94f57a4748fa1a2092e64342856796684e6b8343db685b192745ce"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "19ae9d6f5ef287ab26008d065769608401b9c6907bb2a3f7781bc7276651c804"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

V6 读取方拒绝全部结构性新增：新的 `source` 联合变体、V7 内容块、`developer/message` 与扩展后的 `turn/end` 原因都无法通过 V6 准入，因此该过渡需要格式版本提升。V6 到 V7 的相邻迁移按一一映射就地改写 source 与工具结果：头部以版本 7 重新发布，保留 `seq`、`surfaceOp` 与 `sourceEventSeqs` 坐标，不插入、删除或重编号任何事件。两个无需单独提升的可选字段随同一过渡被接受：`request/header` 的 `tools[].deferLoading` 与 `tool/result` 消息的 `isError`。本次过渡同时在 user/developer `source` 联合上发布记录的 source 策略——attribution 种类词表、`kind` 判别符与未知保留规则——以及使已退役 `tool`/`system` 字段保持关闭的 `@persistenceReserved` 标记；V6 记录两者皆无，因此随同一版本提升进入。已提交的 V6 产物按相邻代规则保持不可变。

<a id="verification"></a>
## 验证

packages/session/session-format-v6-to-v7 提供编解码与 `assertV7RowAdmission`，后者由 packages/session/session-persistence-jsonl/src/format.ts 对每条 V7 行调用；persistence-jsonl 的准入、迁移与发布规格测试对已存储的 V0 至 V6 代运行已安装的 V7 目录。录制会话语料库让每个场景经 V7 写者重放并保留各更早代 fixture，sdk/migration-v6 固定相邻 V6 输入；scripts/session-snapshot-corpus 与 session-fixture-layout 校验代际命名与迁移覆盖。

<a id="dev-note"></a>
## 开发备注

无。
