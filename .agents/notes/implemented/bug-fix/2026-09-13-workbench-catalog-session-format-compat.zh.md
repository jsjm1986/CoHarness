# Agent Note: 工作台目录兼容旧 Session 格式

Status: implemented

[English](2026-09-13-workbench-catalog-session-format-compat.md) | 中文

## Problem

v3 Session reader 可能在相邻迁移链运行前拒绝 v2 JSONL header。个人 runtime 启动失败后，账户工作台会退回个人 runtime 的本地列表，导致账户级目录中的项目对话消失。根 slot 注入还会把首次活动 Workspace 面板缓存成固定值，后续切换面板时文件浏览可能仍访问错误的 runtime。

## Decision

JSONL header 接纳和 coordinator 版本检查使用当前 Session format catalog；这个 catalog 同时提供 v2 到 v3 的迁移。JSONL 声明其迁移钩子会把转换后的事件写入新的不可变 generation；只更新 metadata 的后端继续使用原有行为。个人 runtime 暂时不可用时，Gateway 工作台保留经过 ACL 过滤的账户级记录。Workspace 资源 owner 改为在渲染时通过 getter 解析；文件浏览器会随所属 runtime 重置，目录优先于文件排序，提供面包屑、字节大小和有界重新加载。

## Alternatives considered

**只显示当前 runtime 的会话。** 拒绝，因为个人 runtime 故障会让多 runtime 工作台看不到已授权的项目对话。

**绕过 Gateway 目录或 ACL 获取项目历史。** 拒绝，因为 runtime principal 和项目成员关系仍是授权权威。

**在根注入中缓存活动资源 owner。** 拒绝，因为 Cordis 根注入按注册生命周期缓存，不会跟踪面板焦点。

## Consequences

旧 v2 JSONL Session 会通过 v2 到 v3 链被列出并打开，源 generation 保持不变。个人 runtime 故障期间，账户目录可能暂时只包含项目记录，但不会退化为空目录或个人空间列表。选中项目会话时仍按需启动项目 runtime。Workspace 文件读取保持只读、显式绑定 Session、有界，并独立于 User Documents。

## Verification

`packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` 覆盖 v2 列表、迁移和 v3 successor 发布。Gateway 工作台测试覆盖个人列表失败时保留项目记录。Workbench 测试覆盖动态资源 owner 以及文件浏览器导航和重新加载。
