---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-auto-review-requests

[English](2026-10-24-auto-review-requests.md) | 中文

## 概述

在 execution 准入与模型派发前，保留完整的已解析辅助授权审查请求。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-auto-review-requests
baseline: false
changes:
  - root: "event:auto-review/request"
    previous: null
    after: "a8bb4103bb591122b893b2a6a14ac589c8fd2321a1b46f1ee17fad0efdaa4fc8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

在 Session 格式版本7中增加必须理解的日志事件 auto-review/request，不改变结构。已有日志仍可读取。不认识该事件的旧构建会拒绝受影响日志；当前写入器不将其标为 ignorable。已提交 Session 代次继续保留，不做转换，也不提供降级支持。

<a id="verification"></a>
## 验证

52项相关单元用例通过，改动模块四项覆盖率均为100%。真实源码与构建模式的 TypeScript SDK 组合，以及 Python SDK 投影精确请求，执行自有文件写入，确认3个模型许可全部完成，并在新运行时恢复持久 Session。适配器与准入提供者均为确定性夹具，不覆盖付费提供方行为。

<a id="dev-note"></a>
## 开发备注

无。
