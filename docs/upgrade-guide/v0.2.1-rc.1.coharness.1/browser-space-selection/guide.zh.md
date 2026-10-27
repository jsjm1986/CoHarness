---
kind: upgrade-guide
description: 已认证的 Gateway 页面按账号与 Runtime 分别保存所选对话。
---

# 浏览器空间选择

[English](guide.md) | 中文

## 变更

已认证的 Gateway 页面使用浏览器存储键 `dsh.sessions.current.v2.<accountId>.<target>`，其中 `<target>` 为 `personal` 或 `project-<projectId>`。共用的 `dsh.sessions.current` 记录仍保留，但这些页面不再接纳它。首次访问每个空间时采用通常的历史优先选择。独立页面与显式载体保留现有选择键。Session 日志、文件与工作台布局不受影响。

## 迁移

1. 打开各个人或项目空间，选择以后访问时希望恢复的对话。
2. 切换到其他空间再返回，确认每个空间恢复各自的选择。

无需迁移服务器数据或清理浏览器存储。
