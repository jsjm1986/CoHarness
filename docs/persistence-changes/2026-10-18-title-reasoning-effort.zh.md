---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-18-title-reasoning-effort

[English](2026-10-18-title-reasoning-effort.md) | 中文

## 概述

记录辅助会话标题请求所选定的具体推理强度。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-18-title-reasoning-effort
baseline: false
changes:
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-working-directory"
    after: "e5cc624c414cd8936f004af6fd4617fd85c815a07f625602ef4427c716dbadb2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增 reasoningEffort 字段为可选。现有 V7 记录仍有效，继续保留其未记录强度的事实。路由提供可选推理强度时，已准备的标题请求写入解析后的强度；无需提升 Session 格式版本。

<a id="verification"></a>
## 验证

session-title、session-title-llm 与 first-prompt 提供方测试套件通过：10 个文件、84 个测试，覆盖强度选择、请求记录载荷与缺少该字段的旧记录。session-title-after-turn 快照重录延后并另行跟踪。

<a id="dev-note"></a>
## 开发备注

无。
