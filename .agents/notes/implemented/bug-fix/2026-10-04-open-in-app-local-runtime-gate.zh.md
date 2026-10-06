# Agent Note: open-in-app 动作按 base 运行时归属门控

Status: implemented

[English](2026-10-04-open-in-app-local-runtime-gate.md) | 中文

## 问题

`OpenInAppAction` 对任何摘要中带 `cwd` 的会话都渲染本地应用打开器。会话池合并了所有已建立运行时的行之后，外部运行时持有的会话仍然显示该动作；触发时会把外来路径 POST 到页面宿主的 `open-in-app/open` 路由，而该路由按本机文件系统和应用目录解析路径。

## 决策

宿主本地动作在提供入口前先解析运行时归属。注入的动作用面携带 `localTarget(sessionId)`；生产注入仅在 `ctx.sessions.runtimeTargetFor(sessionId)` 解析为 `{ kind: 'base' }` 时返回 true（缺少解析器时默认 base，与单运行时构建一致）。渲染守卫把非 base 目标视为与缺少目录条目相同的情况并返回 `null`，因此外来会话既看不到分割按钮，也不会向本地路由发出启动请求。

## 文件

- `packages/client/ui-open-in-app/src/client/OpenInAppAction.tsx` — `OpenInAppActionInjected` 上的 `localTarget`；按解析目标做渲染守卫。
- `packages/client/ui-open-in-app/src/client/index.ts` — 经由 `ctx.sessions.runtimeTargetFor` 的生产注入。
- `packages/client/ui-open-in-app/tests/open-in-app-action.client.spec.tsx` — 外来目标夹具渲染为空。

## 考虑过的替代方案

**探测路径是否存在于页面宿主。** 存在不等于归属：外来 `cwd` 可能碰巧与本地路径相同，且从 UI 探测文件系统会跨运行时泄露路径信息；运行时归属才是权威的答案。

**把打开请求转发给属主运行时。** 应用目录与 `open-in-app/open` 路由都在页面宿主上；为一个本地便利动作做跨运行时转发需要一套执行协议。

## 后果

远端会话的 `cwd` 不再能到达页面宿主的打开器。同样的门控模式适用于今后任何目标路由或目录位于页面宿主而非会话所属运行时的动作：渲染前检查 `runtimeTargetFor`（或等价的所有权投影），而不是只看展示字段是否恰好被填充。
