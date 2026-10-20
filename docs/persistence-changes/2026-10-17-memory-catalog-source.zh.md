---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-memory-catalog-source

[English](2026-10-17-memory-catalog-source.md) | 中文

## 概述

确认 `memory-catalog` 消息 source kind 加入 user/developer 消息 `source` 联合（agent/inbox/spliced 插入行、developer/message、session/title-llm-request、user/message）：dsh-memory-context 把它打在发布进会话可见历史的持久已存记忆目录消息上。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-memory-catalog-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-working-directory"
    after: "f366c1c849a0c13f00be016f35b77765a56876ec79d9da91afbd900ba0f4e00b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-working-directory"
    after: "7e65d362e391b74fac891650ef83a8617e34bc4eab2081af6cfdc1e1f4b0d1af"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-working-directory"
    after: "662cecc47bae19290333afe2dcb7a9c07b7ac61cc7390e8d13ea08c7c35cbcff"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-working-directory"
    after: "ed58c1350fc91e330ea6613286e93bbc6bbb0cd83239c6e4439c7598287c323a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该 kind 声明了 `@persistenceAttribution`，因此记录的 source 策略允许它不做版本升级：它只标记产生了一条已被保留消息的来源插件，不新增必填字段，也不给读取方增加新义务。不认识该生产者的读取方按 preserved-unknown 规则保留消息及其未知 source kind，与同一联合上的其他 attribution kind 一致。

<a id="verification"></a>
## 验证

scripts/persistence-changes.ts 在记录的 source 策略下把这四个 root 都归类为 attribution-kind-added；packages/memory/memory-context 的测试覆盖监听器写入 `form`、`update`、`entries` 与 `omitted` 的 `memory-catalog` source，loader-composition 测试把存储条目重放进新会话的目录消息。

<a id="dev-note"></a>
## 开发备注

无。
