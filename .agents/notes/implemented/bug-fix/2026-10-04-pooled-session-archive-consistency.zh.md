# Agent Note: 归档会话归属从 sessions 分区与 Workspace 镜像的并集读取

Status: implemented

[English](2026-10-04-pooled-session-archive-consistency.md) | 中文

## 问题

运行时池按目标为浏览器侧 id 加限定键（`dsh-session:v1:<tuple>`）后，会话身份与归档成员关系分裂到两个投影：`SessionListState.archivedById` 以限定键合并每个已建立运行时的归档集，而 `WorkspaceListState.archivedSessionIds` 以 wire id 镜像单个运行时的归档帧。只读 Workspace 镜像的消费方会把项目运行时会话误分类——调度链接、工作区行、导航守卫、恢复列表、工作台候选都把项目归档当作活跃。同一表面上还有伴随缺口：池从不在 `host/archived-sessions-changed` 帧或 `ensureSession` 内的工作区列表重拉时刷新 `archivedByTarget`；`session.search` 只查基础目标；`visibility`/`projectId` 在 wire schema 与 `SessionListEntry` 之间被丢弃；`uiWorkspace.startSession` 只记录失败而不产出其渲染器已有的 `createFailed` toast；apiproxy fork 路由返回 `session/fork-failed` 而非目录登记的 `fork-failed`。

## 决策

**归档成员关系在每个读取点取两个来源的并集。** `archivedById` 为所有池化运行时携带限定键；Workspace 镜像保留为非池化运行时（其 sessions 列表不分区归档行）的兼容来源。`archivedSet` 是 `derivePair` 投影，同时订阅两个列表，仅 Workspace 重拉也会重新发布。池在归档帧与 `ensureSession` 重拉时更新 `archivedByTarget` 并重建；`search` 扇出到每个已建立目标并对每条命中重键；`sessionSummarySchema`/`SessionListEntry`/`flattenLineage` 携带 `visibility` 与 `projectId`，UI 无需二次查询即可路由限定键。`IWorkspaces.startSession` 接受可选 `onFailure`；`uiWorkspace` 把结构化 RPC 错误格式化为 `code: message` 写入 `createFailed`。fork 路由返回 `fork-failed`。

## 涉及文件

- `packages/client/runtime/src/client/sessions/pool.ts` — 归档帧/重拉同步进 `archivedByTarget`，多目标 `search` 扇出与重键。
- `packages/client/runtime/src/client/sessions/{manager,lineage,service}.ts`、`contract/{sessions-port,workspaces}.ts` — `visibility`/`projectId` 传递、`SessionsPortList.archivedById`、`startSession` 失败回调。
- `packages/host/apiproxy/src/api/sessions.schema.ts` + `sessions.ts` — 会话摘要上的可选 `visibility`/`projectId`；`fork-failed` 错误码。
- `packages/client/ui-workspace/src/client/{index,WorkspaceBrowser,shortcuts}.ts(x)` + `session-actions/derived.ts` — `derivePair` 双源 `archivedSet`、并集守卫、`createFailed` toast 接线。
- `packages/client/ui-schedule/src/client/session-link.ts`、`ui-conversation/src/client/{apply,viewport}.ts`、`ui-settings-unarchive-sessions/src/client/ArchivedSessionsSection.tsx`、`ui-workbench/src/client/components/WorkbenchToolbar.tsx` — 归档并集读取。

## 影响

项目运行时会话现在与个人会话一样正常归档/恢复、标记、链接与导航；陈旧的 Workspace 镜像无法再复活已归档行。`search` 覆盖所有已建立运行时并返回限定键，不再静默限定在基础目标。失败的 New Session 请求以既有的 `createFailed` toast 呈现，保留稳定的 `code: message` 形式。`pinnedSessionIds` 仍是 Workspace 域列表——基础镜像未覆盖处也不提供固定项目会话，与当前产品面一致。
