---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-25-codex-native-model-input

[English](2026-10-25-codex-native-model-input.md) | 中文

## 概述

增加必读的 subagent/codex-model-request 审计事件及 native-stream 操作请求变体。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-codex-native-model-input
baseline: false
changes:
  - root: "event:auto-review/request"
    previous: "2026-10-24-prepared-model-operations"
    after: "e82dda6502239905b3f16f6bff1befdf88299fbfae97bc21d70b347297baad35"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-10-24-prepared-model-operations"
    after: "63544291e7527fddea2c7301917c56761af465066a87eedeaa84974cd747142d"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-10-24-prepared-model-operations"
    after: "a7d8d0fe1542797067ca18ed0f5265132be29d72c4438c5128e98ee4aec32f84"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-10-24-prepared-model-operations"
    after: "339d49829f86b05174848c3e8208f25bf2c11b0e293906cd12fa94377c117bcf"
    decision: same-version
  - root: "event:subagent/codex-model-request"
    previous: null
    after: "60869a3ae5731975dcac7bcc65c0b33600e25389f987eff85d7ee4830a554f9c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新事件在父级对话投影之外记录完整的无密钥 Responses 输入。已有记录仍然有效，不认识该必读事件的读取器会拒绝日志。操作联合类型也出现在自动评审、Stagehand 和记忆请求审计元数据中；这些字段不派生对话消息，既有变体不变。原生 Codex Consumer 只通过自己的新事件写入原生输入。不改变头部、信封或已提交代次，也不隐含降级支持。

<a id="verification"></a>
## 验证

native-codex-sdk-source-advertised-command 通过可运行 TypeScript SDK 转录及新进程续接；native-codex-sdk-python-current 通过相同的 Python 投影。native-codex-private-model-lifetime 通过5个真实原生场景。native-codex-gateway-postgres-resumed-session 通过3个真实 PostgreSQL 参与者、排队策略及执行权限撤销组合。

<a id="dev-note"></a>
## 开发备注

无。
