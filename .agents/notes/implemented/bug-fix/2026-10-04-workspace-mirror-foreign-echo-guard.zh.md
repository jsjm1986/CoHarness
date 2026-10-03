# Agent Note: Workspace 整集回写仅按所镜运行时安装

Status: implemented

[English](2026-10-04-workspace-mirror-foreign-echo-guard.md) | 中文

## 问题

`workspace.archiveSession`/`unarchiveSession`/`pinSession`/`unpinSession` 返回被改注册表的完整 id 集，且会话寻址 api 会把请求路由到会话所属运行时——请求方向正确。但 `WorkspaceManager` 随后无条件把返回集合装进 base 作用域镜像：外部运行时的归档/置顶回写整体替换了 base 集合（重键为错误的限定 id、置顶标记丢失），且外来的 `archiveRevision` 大于本地计数时，之后所有 base `archived-sessions-changed` 帧都会在版本闸上被丢弃。伴生缺陷：`archiveSession` 的同步 pin-drop 用调用方的限定 key 过滤存储的原始 id，池化模式下静默空转。

## 决策

整集一元回写仅在被改会话归属于本管理器所镜的运行时时安装。`WorkspaceManager` 接受 `localSession(id)` 谓词（单运行时构造默认恒真）；`WorkspaceRuntime` 注入 `sessions.runtimeTargetFor(id) === undefined`——池的 base 归属答案；`SessionsPort` 按契约文件记载的扩面缝隙增补该成员。pin-drop 改用反限定 wire id 与原始存储集比较。外来变更的结果仍返回给调用方；所属运行时自己的 `archived-sessions-changed` 帧与池的 `archivedByTarget` 路径承载该目标的真实集合。

## 文件

- `packages/client/runtime/src/client/workspaces/manager.ts` — 四处整集安装的 `localSession` 门控；pin-drop 反限定比较。
- `packages/client/runtime/src/client/workspaces/service.ts` — 谓词接 `sessions.runtimeTargetFor`。
- `packages/client/runtime/src/client/contract/sessions-port.ts` — port 的 Pick 增补 `runtimeTargetFor`。
- `packages/client/runtime/tests/workspaces-service.client.spec.ts` — 外来回写拒绝与限定 key pin-drop 覆盖。

## 后果

项目运行时上的置顶/归档变更不再破坏 base 镜像的集合与归档版本；镜像丢弃外来回写，而该集合对所属运行时自己的池分区仍然权威。遗留缺口保持记录：外部运行时的 `pinned-sessions-changed` 帧仍无消费方，因此置顶只在 base 镜像覆盖的面内有意义——产品面不变。
