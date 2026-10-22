---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-job-events

[English](2026-10-19-job-events.md) | 中文

## 概述

为 jobs 子系统新增仅记日志的 `job/registered` 与 `job/settled` 事件根：生产者通过 job 注册表登记持久化 job 身份并结算终态结果，注册表把两条记录写入 Session 日志。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-job-events
baseline: false
changes:
  - root: "event:job/registered"
    previous: null
    after: "f5520c1d261ca86ea03735799c311a0a9ede8babb588cf0a65422576d2ee0ad1"
    decision: same-version
  - root: "event:job/settled"
    previous: null
    after: "edd37b1e4974af648633014435572089b1e8fb71910468a0767a7e28fdd22abf"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个根均为新增；已有记录不受影响。这两个事件是 merge-extensible 的 SessionEventMap 增量成员，只由 job 注册表写入，已发布日志不会携带它们，无需提升 Session 格式版本。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/test-support/session-snapshot/tests/suite.spec.ts：回放的 Session 中已登记与已结算的 job 记录保持字节稳定。

<a id="dev-note"></a>
## 开发备注

无。
