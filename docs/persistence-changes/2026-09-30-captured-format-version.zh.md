---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-captured-format-version

[English](2026-09-30-captured-format-version.md) | 中文

## 概述

确认 agent/inbox/spliced、developer/message、session/title-llm-request 与 user/message 载荷中 source.references[] 上新增的可选字段 capturedFormatVersion：引用现在记录其捕获内容来自哪个 Session 格式版本。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-captured-format-version
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-30-v7-tool-result"
    after: "b81c9983d178996c4f994fb4ae8b3b2eb2babd12a2f22de72477a5028e63f70c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-v7-tool-result"
    after: "30b19509806348b545945e42357c4bdf50865bf02cf49a7f4a50dd4349f668e3"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-v7-tool-result"
    after: "2e67c918285d4485db9235a00a13a92cd5796536e72442d261c8eb50f02a8c10"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-v7-tool-result"
    after: "8de225d2721d0d6ea44d6d11f46aa1b59a9b9638da88bb73c7465fbfcca5b055"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

每项改动只为引用元素增加一个可选属性。写入方可以输出该字段，读取方必须接受缺省，现有载荷语义不变，因此 Session 格式版本保持不变。

<a id="verification"></a>
## 验证

四个事件 schema 在当前清单与本记录的 after 快照中均携带该可选字段；packages/context/session-reference 在捕获快照格式版本已知时写入它，其 spec 覆盖 seeded 与非 seeded 捕获。

<a id="dev-note"></a>
## 开发备注

无。
