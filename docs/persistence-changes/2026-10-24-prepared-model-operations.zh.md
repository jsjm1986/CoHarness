---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-prepared-model-operations

[English](2026-10-24-prepared-model-operations.md) | 中文

## 概述

在辅助请求中记录原生模型操作，并记录精确 Sonar 搜索请求。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-prepared-model-operations
baseline: false
changes:
  - root: "event:auto-review/request"
    previous: "2026-10-24-auto-review-requests"
    after: "058810a9e5b06610cce18c0c41af56dbdf69b5f585fbae3f963ed43e71d497bf"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-10-24-stagehand-governed-model-inputs"
    after: "151fa0af6e87fabaa7e497fa6869f1821cf39ac50d3d0e500e6f1972a16259d0"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-10-24-memory-auxiliary-requests"
    after: "3d9e1a1b04cd5fb5b031baa76257e76f5d4cba9d5f990acf695cc1f2c9324838"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-10-24-memory-auxiliary-requests"
    after: "77b9228dffa9bf96867e702734391cdf528878e007b48253ca44c0d0c0dc709b"
    decision: same-version
  - root: "event:web/perplexity-search-llm-request"
    previous: null
    after: "0951068900ea2532daa58a0018ae60e013977ea692b9553e9f8b232527b49d03"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

可选操作描述符在 Session 格式版本7扩展自动复核、Stagehand 与记忆请求载荷。必需的 web/perplexity-search-llm-request 事件记录精确 Sonar 端点和 JSON body；不理解它的读取器会拒绝日志。既有记录仍有效。不引入结构代次转换、已提交 JSONL 重写或降级支持。

<a id="verification"></a>
## 验证

219项定向原生传输、准入、捕获代次和实际治理用例通过，变更模块的语句、分支、函数与行覆盖率均为100%。源码与构建模式的 TypeScript SDK 流程，以及 Python SDK 通过真实 web 工具执行 Messages 与 Sonar，在受控本地 HTTP 前验证输入物理落盘，并在新进程恢复。独立的实际构建治理组合验证一次获准请求、一次模型许可释放、file/personal 用量，以及拒绝后续请求且不发出 HTTP。完整构建的8个阶段通过。这些夹具不证明付费外部提供方行为或完整 Gateway 节点预算与 PostgreSQL 入账。

<a id="dev-note"></a>
## 开发备注

无。
