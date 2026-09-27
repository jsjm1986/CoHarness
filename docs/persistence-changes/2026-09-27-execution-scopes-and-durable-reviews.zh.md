---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-execution-scopes-and-durable-reviews

[English](2026-09-27-execution-scopes-and-durable-reviews.md) | 中文

## 概述

新增必读的执行协议标记与续执行事件、可选的不可变执行作用域引用，以及可选的持久工作区审阅元数据。这些事件正文增量保留当前 Session 写入格式 6，不修改已发布的头部、事件信封或相邻迁移。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-execution-scopes-and-durable-reviews
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-22-v5-execution"
    after: "70704a22165788bd25d97d562d81a1a3d7024ed480cbff8b18213e841498a90c"
    decision: same-version
  - root: "event:gateway/continuation"
    previous: null
    after: "81a6fccc775c0a082791a4fa3bb916b6355c8877c0ca6e1780e5cf01366b0cd3"
    decision: same-version
  - root: "event:gateway/execution"
    previous: "2026-09-22-v5-execution"
    after: "820864922123bf28895e9074ada5d705c65ce0cff058b3807e1b2a5fa3686d70"
    decision: same-version
  - root: "event:gateway/scoped-execution"
    previous: null
    after: "8086a722e54f2867cebf78c887cdef6c9ed7438313a0a133f6d2f3ce72d99944"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-22-v5-execution"
    after: "93c2f2271ce39bcff1b212d260bf60c93e7a51bc3ef67291e1d38b3b8fffb1ef"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-22-v5-execution"
    after: "6d67dec8de1c5e780271e492d420741ae1d4533b510ad7cb897982b596dfd439"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-22-v5-execution"
    after: "8c5b6f098f2c2a70d17f3c08212d184408c29a9ca5c5e2ddb14a5832dd4d3cd4"
    decision: same-version
  - root: "event:workspace/changes"
    previous: "2026-09-23-deliverables-events"
    after: "1c062d75afe0e9ae846b18a1d2f5bd1bdb81bb2714bc8d83f74ef0df8f72d474"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧记录允许缺少 scopeId 和审阅元数据。当前执行 provider 保留旧输入校验，不虚构缺失的委派身份，也不借用另一请求的 Auto 资格。每次现代作用域首次准入前记录必读 gateway/scoped-execution 协议标记；持久异步续执行使用必读 gateway/continuation 事件。使用 #232 事件词表的读取方会拒绝这些未知必读事件，因此不能把收窄后的作用域静默解释为累计授权。当前投影也会拒绝没有标记的 scopeId。可选作用域引用随排队输入、标题请求和 Team 消息传递，不改变原有字段。工作区摘要保留原有文件与计数字段；reviewId 定位已提交的历史内容，incomplete 记录存储失败，requiredReviewBytes 支持有界恢复。这些字段不替换模型可见消息，也不声称文件副作用已被回滚。缺少审阅元数据时保留历史摘要行为；持久审阅读取与存储失败后的恢复需要更新后的 workspace-changes provider。同版本准入不承诺旧产品实现新增行为或支持降级。

<a id="verification"></a>
## 验证

node_modules/.bin/vitest run packages/context/gateway-execution/tests/reader-admission.spec.ts packages/context/gateway-execution/tests/projection.spec.ts packages/deliverables/workspace-changes/tests/durable-review.spec.ts packages/deliverables/workspace-changes/tests/review-store.spec.ts 的 23 个测试全部通过。[读取器测试](../../packages/context/gateway-execution/tests/reader-admission.spec.ts) 使用 #232 已知事件清单及其未修改的已发布 v5 与 v6 读取器：旧读取器接受单独增加的可选 scopeId，拒绝新增必读标记和续执行事件，当前读取器则接受完整记录。[审阅测试](../../packages/deliverables/workspace-changes/tests/durable-review.spec.ts) 覆盖重启读取和存储失败后的准入。这些结果属于本地候选验证，不代表部署或发布验收通过。

<a id="dev-note"></a>
## 开发备注

无。
