# Agent Note: Hero 工作区行只保留 Workspace 选择器

Status: implemented

[English](2026-09-17-hero-workspace-row-simplification.md) | 中文

## Problem

Hero 工作区行累积了四个控件，其中两个互相冲突：“新建对话”按钮重复了 Hero 本身所代表的状态——它的编辑器就是空白草稿入口——而 Workspace chip 上的文件夹图标紧挨工作台工具栏的文件浏览文件夹图标，两个相同图标含义不同，看起来像同一个文件操作。

## Decision

Hero 工作区行只保留导航与范围控件：工作台 leading 槽位、Workspace chip、工作区选择器和 agent-preset 槽位。chip 的图标换成新的层叠菱形 `IconWorkspaceOutline16`——范围/层级隐喻——取代文件夹，使 chip 不再与相邻的文件按钮冲突，也不会被读作文件操作。显式新建会话保留在侧边栏入口和每个 Workspace 行的加号上，两者仍走 `startSession` → `connectWorkspace` 路径。`ConversationInjected.newSession` 随唯一消费方一并移除。

## Alternatives considered

**保留 Hero 按钮。** 否决：在 Hero 上该按钮只能重新解析出编辑器已经代表的同一个空白会话，其余入口已覆盖从其他位置发起新会话的需求。

**保留文件夹图标。** 否决：两个相邻文件夹图标（工作台文件按钮与 Workspace chip）让两者看起来是同一个文件操作。

**复用现有非文件夹图标。** 否决：图标集中没有表达 Workspace 范围语义的图标——panel-left 是侧边栏开关，data、plan、skill 图标各有归属。

## Consequences

Hero 上的新建会话意图只有一种表达——编辑器本身——chip 的层叠图标在视觉上把范围选择与文件浏览分开。会话创建路径、草稿 reservation 与 `workspaceId` 分组提示不变。上游仍使用文件夹图标，因此该图标是 fork 为自身额外的工作台控件所做的有意分叉。

## Verification

Conversation 与 ui-primitives typecheck 通过；lifecycle-chrome 与 agent-preset-selection 的 Hero 快照在移除按钮后重新录制；组装 Web 场景仍验证历史优先进入。

## Related

- [明确的 Workspace 新建会话意图](2026-09-01-explicit-workspace-new-session.zh.md) — 其 Hero 入口部分由本记录取代；Workspace 行加号、历史优先选择与提示机制仍然有效。
