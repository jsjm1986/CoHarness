# Agent Note：右侧 Sidebar 文件树 tab 落在 fork 的连接与资源接缝上

Status: implemented

[English](2026-10-19-sidebar-files-tab-port.md) | 中文

## 问题

上游 `dsh-v0.2.1-rc.2` 带有 `packages/client/ui-sidebar-files`：右侧 Sidebar 的 `files` tab 类型，懒加载列出 Session 的工作区目录树、监听已展开目录、以 `dsh-resource://file/**` 资源地址打开文件。fork 的 `ui-workbench` 的 `workspace-file` tab 类型早已认领该地址族，但可停靠的树本身没有组成入口——相对上游是一个可见的放置位缺口。

上游包依赖 fork 没有的两条接缝：`@deepseek-ai/dsh-api-workspace-files` Remote 命名空间上的位置参数 `remote.workspaceFiles.list(sessionId, absolutePath)`，以及每个目录一条的 `workspaceFiles.changes` Typert 流。fork 的等价物是 `connection.api.workspaceFiles.list({ sessionId, path })` 线路——相对 `path`、`RpcResponse` 包络——以及由 Host 的 `host/workspace-file-changed` 帧驱动的 `workspaceResources` 失效源。

## 决策

不改公共面，把包移植到 fork 接缝上：

- `face.ts` 经 `createList(resolve, relativeOf)` 绑定列举：`resolve` 返回 Session 的 `connection`（base target）或 `connection.forTarget(target)` 的 `workspaceFiles` 句柄，`relativeOf` 把显示的绝对目录换算成工作区相对路径，线路调用对根发送 `{ sessionId }`、对子目录发送 `{ sessionId, path }`。失败以 `RpcError` 呈现。
- `createWatch(resources, targetOf, relativeOf)` 用每打开一个 `DirectoryNode` 一条 `workspaceResources.observeChanges` 订阅替代每目录一条流，按 `sessionId` 与目录前缀过滤 `host/workspace-file-changed` 帧。订阅在产出 `ready` 之前就位，使就绪与首次拉取之间不丢帧；每个接受的帧先入队再唤醒挂起的生成器，因此唤醒不会消费一个未入队的变化。
- `WorkspaceResourceRegistry.observeChanges(target, listener)` 是注册表的新方法——此前失效事件只能经 `handleChange` 写入，没有供功能代码订阅的入口。
- `index.ts` 在共享 tab 管线之外注入 `connection`、`sessions`、`workspaceResources`，把 `files` 类型注册进 `sidebarRightTabs`，正文注册进键控 `sidebar.right.pane.tab`，标签标题注册进 `sidebar.right.pane.tab.title`，声明 Session 作用域的 `sidebar.right.tab.files.actions` 列表，并按平台默认绑定 `workspace.files` 命令。
- 文件打开不变：`fileAddressFor` 生成 `dsh-resource://file/session/<sessionId>/<path>`，`tab.actions.openResource` 把它落在该 tab 自己的 pane 里，由 `ui-workbench` 认领。

## 备选方案

- **一并移植 `ui-sidebar-documentpreview`** ——本次拒绝：fork 的 `ui-workbench` 已认领 `dsh-resource://file/**` 并带 Markdown、代码、HTML、PDF、Excel、Office 与图片渲染器，上游预览包会与已有面重复。
- **携带上游 `workspaceFiles.changes` 流** ——拒绝：fork 的 `fs/observed` → `host/workspace-file-changed` → `workspaceResources` 通道已发布同样的事实；再加一条流只是为无新信息多付一份订阅。
- **保留 Workbench 文件浏览器作为唯一入口** ——拒绝：它是模态浏览器；平价目标是可停靠的 tab 面。

## 后果

fork 的 `workspaceFiles.list` 应答工作区相对路径，因此 cwd 换算由 face 负责——没有工作目录的会话渲染一行说明，与上游契约一致。actions 列表随发布为空：树内尚无插件向 `sidebar.right.tab.files.actions` 注册内容（`ui-open-in-app` 属排除面）。`pnpm install` 没有需要映射的上游专有依赖名；清单由 `verify-client-packages --fix` 与其他移植包一并归位。

## 验证

- `pnpm exec vitest run packages/client/ui-sidebar-files/tests` ——85 个测试通过，覆盖 apply、definition、store、directory-node、face、watch、body、title 各 spec，含中止代际、释放与变化排队竞态。
- `pnpm exec tsc -b packages/client/ui-sidebar-files/tsconfig.json` ——client 严格面下干净。
- `pnpm --filter @deepseek-ai/dsh-client-ui-sidebar-files run bundle` ——产出 `lib/index.js`（惰性 Host 入口）与 `lib/client.js`。
- `pnpm run verify-cordis-config` ——409 个配置文件通过；`web-app` patch 注册该插件及其清单依赖。
- `pnpm exec tsx scripts/verify-client-packages.ts` ——清单修复后 69 个 client 包满足依赖与模块请求规则。
