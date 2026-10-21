---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-18-rc2-catalog-and-ptc-metadata

[English](2026-10-18-rc2-catalog-and-ptc-metadata.md) | 中文

## 概述

记录用于外部执行的 `subagent/catalog` payload 版本 2，以及 `tool/ptc-dispatch` 结算事件中可选、由工具拥有的 JSON 展示元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-18-rc2-catalog-and-ptc-metadata
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-18-coharness"
    after: "53750b9abf61efb7992b0aadc3e247ec927449c63266df28230fd1139f5590ac"
    decision: same-version
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-30-v7-tool-result"
    after: "d66e11dddf5dfa3c71547e2cbd7b0608824cd8d6243fc16f532017ff28e8fba5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

Catalog payload 版本 0 和 1 的字段及含义保持不变。版本 2 标识外部执行，它是发现列表中的叶条目，而非本地子 Session；读取方必须支持该 payload 版本，并拒绝版本与 mode 不匹配的组合。当前 V7 codec 已校验这些版本，因此本次确认不增加 Session 格式迁移，也不重写任何已存储代次。PTC 元数据为可选项；缺少该字段的旧事件保持原有行为。元数据与可变工具值分离，也与模型可见内容分离。

<a id="verification"></a>
## 验证

`pnpm exec vitest run packages/subagent/subagent/tests/catalog.spec.ts packages/core/tools/tests/ptc.spec.ts` 通过 136 项测试。覆盖混合 catalog 版本、非法版本与 mode 组合，以及分离后的 PTC 元数据在 Session 恢复后仍保留、且不改变绑定结果或落盘内容策略。

<a id="dev-note"></a>
## 开发备注

无。
