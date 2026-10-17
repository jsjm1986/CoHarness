---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-memory-recall-source

[English](2026-10-17-memory-recall-source.md) | 中文

## 概述

确认在 agent/inbox/spliced 插入行、developer/message、session/title-llm-request 与 user/message 的用户/开发者消息 `source` 联合类型上新增 `memory-recall` 来源种类：dsh-memory-context 用它标记发布进会话可见历史的按问题召回注入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-memory-recall-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-memory-catalog-source"
    after: "69090a7657308107dd797d55e8da7ae71ed41b10628ecc4a3dec2a0304df25a2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-memory-catalog-source"
    after: "43d9952c3e9bf925d8146d1306e574fee890724a880c6cf632bda242676b0753"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-memory-catalog-source"
    after: "3c685dc08e3d30cb3ae9501b9eac2b7bbeb66526ad24801b76dcaa2bdb39b310"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-memory-catalog-source"
    after: "946d3ecb0c0b85d1f64e22bac7a2d89dcf24e6dba7aae9a95adcdb1defb6386c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该种类声明为 `@persistenceAttribution`，因此记录的 source 策略在同版本下接纳它：它只命名一条已保留消息的产生者，不新增必填字段，也不给读取方新增义务。未见过该产生者的读取方按未知来源保留规则保留消息及其未知种类，与同一联合类型上的其他归属种类一致。

<a id="verification"></a>
## 验证

scripts/persistence-changes.ts 在记录的 source 策略下把四个根分类为 attribution-kind-added；packages/memory/memory-context 的用例覆盖选择器为 `memory-recall` 标记 `form` 与 `keys`、耐久键折叠以及逐会话字节预算。

<a id="dev-note"></a>
## 开发备注

无。
