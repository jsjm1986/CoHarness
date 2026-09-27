---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-v5-execution

[English](2026-09-22-v5-execution.md) | 中文

## 概述

将 Session 存储推进到 V5，使 JSONL 能读取 V4 写入器已经输出的可选 draft 标头，并在 Session 事件中记录经验证的 Gateway 执行身份。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-v5-execution
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-21-v4"
    after: "becb738db5b4c2865a69cc40df806519d781feea1ab1b3d177539b5b9188ec66"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-21-v4"
    after: "8102d6727bb57bbea3bb78b5622996246ae4609d0bddf332ef0f2c6657493dad"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-v4"
    after: "6a12ecfb066aafd62c6a857c7898e2f8b2237aba3b5856f391d9aa7d521b1fb6"
    decision: version-bump
  - root: "event:gateway/execution"
    previous: null
    after: "a8e61a09f296a93e9ba18c7b01cdd85401500ac6ddba8750cf3cdd75610acf5e"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-v4"
    after: "0735bc4fb1d335aad0b9b8289d5638fa8f7f1f3dc5bd79b501fe5c567f92b867"
    decision: version-bump
  - root: "event:team/message/queued"
    previous: "2026-09-21-v4"
    after: "3c172e2172241690c27e5a3fac4d6930ad8bcfe9b7060af088052c8e4332e94e"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-21-v4"
    after: "19cb7b6061859227ee6f7f46deb1775629d78ad9d730b69b262e36380227196e"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

V4 的物理标头校验会拒绝其编码器已输出的 draft 字段。V5 接受这一可选布尔值，并把必需的标头版本从 4 改为 5。相邻的 V4 到 V5 迁移保留事件、序号、继承截点和 draft 值，只有显式写入时才发布新的 V5 代次；原 V4 字节不变。旧消息可以没有可选的 gatewayExecutionScope；新的 gateway/execution 事件是受管授权的必读事件，但旧 V5 日志可以没有它，此时不能获得特权身份。V4 读取器拒绝 V5 标头，因此这些新增项不声称 V4 可以向前读取。消息 `source` 联合接受 `webhook` 变体；没有该成员的更早 V5 读取器会拒绝携带 webhook 来源消息的日志。

<a id="verification"></a>
## 验证

V4 到 V5 迁移及 JSONL draft／代次测试在三个文件中通过 101 项测试。Gateway 执行投影与授权测试在两个文件中通过 41 项测试。受影响的 Session、Gateway 执行、Auto review 和 Host 包源码类型检查通过。

<a id="dev-note"></a>
## 开发备注

无。
