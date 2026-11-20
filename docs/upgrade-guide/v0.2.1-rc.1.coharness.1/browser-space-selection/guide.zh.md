---
kind: upgrade-guide
description: 已认证的 Gateway 页面仅恢复按账号与确切 Runtime 划分的标签页内选择。
---

# 浏览器空间选择

[English](guide.md) | 中文

## 变更

已认证的 Gateway 页面使用本标签页 session storage 中的 `dsh.sessions.current.v3.<accountId>.<runtimeId>.<target>`，其中 `<target>` 为 `personal` 或 `project-<projectId>`。local storage 中的 `dsh.sessions.current` 及 `dsh.sessions.current.v2.<accountId>.<target>` 记录保留但不被接纳，因为它们无法确定是哪台电脑或哪个标签页选择了原始 Session ID。缺少确切 Runtime 或已保存的标签页记录时采用通常的历史优先选择。独立页面与显式载体保留既有行为。Session 日志、文件、草稿与工作台布局不受影响。

## 迁移

1. 同时升级 Gateway 和客户端资源，使已认证页面提供确切 Runtime 身份。若某个打开的标签页没有已保存的标签页记录，在其中重新选择一次目标对话。
2. 在同一个 Runtime 的两个标签页中选择不同对话，并在第三个标签页打开另一台电脑。分别刷新，确认各标签页保留自己的目标和对话。

无需迁移服务器数据或清理浏览器存储。
