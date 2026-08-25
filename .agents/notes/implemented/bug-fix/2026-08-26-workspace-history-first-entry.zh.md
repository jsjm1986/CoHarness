# Agent Note: Workspace 进入优先打开历史会话

Status: implemented

[English](2026-08-26-workspace-history-first-entry.md) | 中文

## Problem

进入 Workspace 时沿用了明确“新会话”操作的空白会话复用路径。因此 Workspace 已经存在对话记录时，用户看到的是空 Hero，而不是应当继续使用的对话。

## Decision

`WorkspaceRuntime.openWorkspace()` 从现有 Workspace 与 Session 列表快照中选择最新的、当前可见、非空、未归档的根 Session，不额外请求列表；Workspace 没有符合条件的历史时回退到 `connectWorkspace()`。启动流程与 Hero Workspace picker 使用历史优先入口；明确的新会话操作继续使用空白会话路径。

Hero picker 的当前 Session 存在未发送文字、图片或文档时要求确认。确认路径先解析目标 Workspace，成功后再清空浏览器拥有的草稿并释放预览／上传资源，然后打开目标历史；取消或目标失败都会保持当前 Session 与草稿不变。

## Alternatives considered

**把 `connectWorkspace()` 改为历史优先。** 否决：侧栏“新会话”和 Workspace 加号依赖它的空白会话复用保证。

**打开手工排序中的第一条 Session。** 否决：继续工作应跟随最近活动，Workspace 顺序仍属于独立的展示偏好。

**把 Hero 未发送草稿转移到目标 Workspace。** 否决：这会隐藏目标历史，并让草稿以隐式新对话出现；当前流程要求用户明确确认放弃后再切换。

## Consequences

桌面与紧凑 Web 布局都会让回访用户进入最近可用的对话。没有历史的 Workspace 继续显示现有空白 Hero，明确的新会话行为保持可预测。历史选择只对已加载摘要执行 O(n) 扫描，不增加模型调用或列表请求。Hero 草稿在确认后按设计丢弃并释放浏览器资源；取消会保留草稿。

## Verification

Runtime 测试覆盖最新历史选择、空白／归档／subagent 排除、空 Workspace 回退创建和启动行为。Conversation 测试覆盖确认、取消、失败回滚和确认后的清理。组装 Web 场景覆盖桌面与 390px 启动历史，以及明确新会话进入空白 Hero；快照固定渲染后的对话状态。
