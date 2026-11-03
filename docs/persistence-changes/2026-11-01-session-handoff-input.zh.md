---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-session-handoff-input

[English](2026-11-01-session-handoff-input.md) | 中文

## 概述

在调用方 Session 内于派发前记录每次辅助交接模型输入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-session-handoff-input
baseline: false
changes:
  - root: "event:session/handoff-llm-request"
    previous: null
    after: "e158e789d5f24a4b55c6de22ff22778917df7635ab0d4235ad87d19b282565f5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增必读的 session/handoff-llm-request 事件，包含源 Session、请求路由和完整输入消息。已有事件继续有效。不认识此事件的旧构建按现有未知必读事件规则拒绝受影响日志。不改变 Session 头部或结构格式，不重写已提交代次。

<a id="verification"></a>
## 验证

查询工具与真实 SQLite 套件通过156项测试，覆盖四种替换 token 模式及请求记录失败。实际源码及构建后的 Node22 TypeScript SDK 组合与 Python SDK 各通过七个交接场景，验证字面输入先于物理派发，并通过真实持久化提供方读回。私有完整原工具包的七个源码场景均因缺失请求记录而失败。已经具备记录功能的完整包在源码与构建模式的字面文本场景中失败。

<a id="dev-note"></a>
## 开发备注

无。
