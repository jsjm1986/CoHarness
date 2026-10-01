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
    after: "c2cb3d8c8da40ffc59ce9101819cbb2ebb7db013d68c6c6f24212f96a0ea1d7d"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-21-v4"
    after: "8e551c3f10065b20d3e5cb6bfde0589863be64be79f5200e7863128bcb69c270"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-21-v4"
    after: "f12eaba818724effce06f9bdb2f588571fd5635c1878a4cb27de8eb9fce49906"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-21-v4"
    after: "f8fa8c5a6a47b23509f46b6ff6441ae7a66f3114b84ec2470df4a5a74d586802"
    decision: version-bump
  - root: "event:developer/message"
    previous: null
    after: "5320348194cbbdd3f0332a88ffafd298bb5653dab4a5ef8d4e45f8a19b3fa782"
    decision: version-bump
  - root: "event:request/header"
    previous: "2026-09-21-v4"
    after: "a5805fab2457f244f1124989f2d50e48544294de239092278992db8b95807f71"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "1f8decc10456cbcd8c952378918b915209c4e5076b925e967054967cf95d76ca"
    decision: version-bump
  - root: "event:system/message"
    previous: "2026-09-21-v4"
    after: "7458c8c4c4c8680f8e34181f26646ef2f4dfe90604b4b48f97583b35a7d6ddcc"
    decision: version-bump
  - root: "event:team/message/queued"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "81015090958d429f1b861db7dd28a260a092e305aacb9cd05edbf0e4097aef6d"
    decision: version-bump
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-21-v4"
    after: "0587e446c5bcafffdb12fb5a836a8cfafa31d6f0df65cba20e8108be6acaeb3e"
    decision: version-bump
  - root: "event:tool/result"
    previous: "2026-09-21-v4"
    after: "d1468b7a9b9f41d9ea09be46ff2708e1fd33742817b5bc0ab1147f97d34e5a2f"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-21-v4"
    after: "0f8512903d94f57a4748fa1a2092e64342856796684e6b8343db685b192745ce"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "c61fe5daf5ee4c1c344188ecd64ecad8acce295dca9b5e87c6f92dc9278cbc27"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

V6 读取方拒绝全部结构性新增：新的 `source` 联合变体、V7 内容块、`developer/message` 与扩展后的 `turn/end` 原因都无法通过 V6 准入，因此该过渡需要格式版本提升。V6 到 V7 的相邻迁移按一一映射就地改写 source 与工具结果：头部以版本 7 重新发布，保留 `seq`、`surfaceOp` 与 `sourceEventSeqs` 坐标，不插入、删除或重编号任何事件。两个无需单独提升的可选字段随同一过渡被接受：`request/header` 的 `tools[].deferLoading` 与 `tool/result` 消息的 `isError`。已提交的 V6 产物按相邻代规则保持不可变。

<a id="verification"></a>
## 验证

packages/session/session-format-v6-to-v7 提供编解码与 `assertV7RowAdmission`，后者由 packages/session/session-persistence-jsonl/src/format.ts 对每条 V7 行调用；persistence-jsonl 的准入、迁移与发布规格测试对已存储的 V0 至 V6 代运行已安装的 V7 目录。录制会话语料库让每个场景经 V7 写者重放并保留各更早代 fixture，sdk/migration-v6 固定相邻 V6 输入；scripts/session-snapshot-corpus 与 session-fixture-layout 校验代际命名与迁移覆盖。

<a id="dev-note"></a>
## 开发备注

无。
