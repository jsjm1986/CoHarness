---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-stagehand-governed-model-inputs

[English](2026-10-24-stagehand-governed-model-inputs.md) | 中文

## 概述

在每次 Stagehand 浏览器推理派发前记录经宿主路由的确切模型输入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-stagehand-governed-model-inputs
baseline: false
changes:
  - root: "event:browser-use/stagehand-llm-request"
    previous: null
    after: "25c645080c2da89aa1c6f386d7348d315e4c35c76883399268bd5e227495e33e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

增加必需的日志事件 browser-use/stagehand-llm-request，不改变 Session 结构或版本。已有日志仍有效。不认识该事件的旧构建会拒绝受影响的日志，避免遗漏模型可见输入。此记录不恢复浏览器状态。

<a id="verification"></a>
## 验证

浏览器提供方的 146 个用例通过，五个受影响源码文件的语句、分支、函数和行覆盖率均为 100%。源码及构建后的 headless 和 TypeScript SDK 场景、Python SDK 投影、三个已安装 Chromium 用例，以及模型治理计费和准入期间拒绝用例通过。

<a id="dev-note"></a>
## 开发备注

无。
