---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-managed-prompt-receipts-and-reply-participants

[English](2026-11-05-managed-prompt-receipts-and-reply-participants.md) | 中文

## 概述

记录 Host 提交输入的可选持久受理摘要，以及继续回答用户问题时记录的可选参与者身份。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-managed-prompt-receipts-and-reply-participants
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-26-optional-document-identity"
    after: "fd4bf2fe1c0a983948fbd7bce58ed68db3109dfa9ec5d7212c3ebdda2fbed7c1"
    decision: same-version
  - root: "event:auto-review/request"
    previous: "2026-10-26-optional-document-identity"
    after: "62f160ea12a92d75e9013efb75f15489851ebe70d186acf95b067b26356b27c4"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-10-26-optional-document-identity"
    after: "1158a4a17d3196e3269140507d8bf238a3a963ec8fdd91beb9313dbb858a5e71"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-26-optional-document-identity"
    after: "63e462325bdc12edb05a83f056772b94a35c45fa053b1ec1dfd877ad321ccf12"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-10-26-optional-document-identity"
    after: "c454a447df270a2300cd87fd87cf2a63cb2e572b0c959a45b95cbe76cc5fdfa3"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-10-26-optional-document-identity"
    after: "bee19ec1298c5710078bf11d6db83dd7c5bce95f550d630173212319b2c27e97"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-26-optional-document-identity"
    after: "9df385243c17515c9ddeef9086ffc3472f91755e9ce78358718793c1d751f671"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-26-optional-document-identity"
    after: "e98aeb2e42895e6a60e3c7677da4e25fc0b95006c33af095dac396e26a76198d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

普通输入可以省略 admission，已有的问题回复可以省略 participant。所属 Host 用操作摘要和内容摘要核对已落盘的输入。每次请求仍核验项目成员及提交者身份。回复已记录参与者时，保留其归属。新增字段不改变消息正文、事件顺序、Session 头或已提交的文件代次。

<a id="verification"></a>
## 验证

实际安装的 R49、R50 CoHarness JSONL 读取器均还原了 v7 会话。用例分别使用原有来源、带受理摘要的来源和带参与者的问题回复。收件箱插入及用户消息中的来源和正文均完整保留。真实 Host 回执丢失后查回原结果，持久输入只有一条。

<a id="dev-note"></a>
## 开发备注

无。
