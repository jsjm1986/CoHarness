---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-v6-ssh-target

[English](2026-09-24-v6-ssh-target.md) | 中文

## 概述

将 Session 存储推进到 V6，使 JSONL 能够读取 V5 写入器已发射的可选 sshTarget 标头绑定，并把该可选标头字段确认为耐用 Session 元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-v6-ssh-target
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-22-v5-execution"
    after: "9136dd6271b5aba11b4748a03cb05bdb0cc9b05f17be5af3d87a86406177033c"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-22-v5-execution"
    after: "4e26a4a482d42df86166259d181b53f33e1a52e735968253d79d9a743aa0b9fa"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

V5 读取器会拒绝携带 sshTarget 的物理标头，因为其 JsonlHeaderLine 白名单不含该键，因此该协议变更需要推进格式版本。V5→V6 相邻迁移接受所有 V5 标头、保留已存在的 sshTarget，并以版本 6 重新发布产物，不改变事件行、序号、继承切点或负载。

<a id="verification"></a>
## 验证

packages/session/session-format-v5-to-v6/tests/migration.spec.ts 覆盖携带与缺少 sshTarget 的 V5 标头、非法 sshTarget 值、未知标头键以及事件字节不变性；JSONL 准入、迁移与发布规格对已安装的 V6 目录运行了 V0 至 V5 的全部存量代际。

<a id="dev-note"></a>
## 开发备注

无。
