---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-memory-auxiliary-requests

[English](2026-10-24-memory-auxiliary-requests.md) | 中文

## 概述

在发送前记录每次记忆召回选择器以及提取或整理轮次的精确已解析输入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-memory-auxiliary-requests
baseline: false
changes:
  - root: "event:memory/curation-request"
    previous: null
    after: "e1c43217d6952171eed0632c369ea619ac0aeb700a0f7621f5acec9cc4c654c1"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: null
    after: "6a9be45ed50e3a6424d93fcc92c75118efd39781184a1dde7528edb766948f1f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

在 Session 格式版本7中增加必须理解的日志事件 memory/recall-request 与 memory/curation-request，不改变结构。已有日志仍可读取。不认识这些事件的旧构建会拒绝受影响日志；当前写入器不将其标为 ignorable。记忆域记录无需转换。

<a id="verification"></a>
## 验证

99项相关单元检查通过，两个改动插件的语句、分支、函数和行覆盖率均为100%。源码与构建模式的 Loader 回归、真实 TypeScript 和 Python SDK 投影均通过。共享的确定性适配器逐项比较完整持久请求与发送输入，并确认4个模型许可全部静止；它使用受控准入提供者，而非真实模型 HTTP 端点。

<a id="dev-note"></a>
## 开发备注

无。
