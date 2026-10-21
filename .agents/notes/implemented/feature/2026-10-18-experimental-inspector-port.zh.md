# Agent Note：经 fork 接缝移植实验性开发者工具

状态：已实现

[English](2026-10-18-experimental-inspector-port.md) | 中文

## 问题

上游 rc.2 携带一组实验性开发者工具——DevTools `inspector`（`captureFetch`、Console 求值、Sources、Elements 树、CDP 无关查询 API）、`session-inspector`（虚拟化原始 Session 日志与 Chat 组/节点表格，含流式增量行），以及 `inspector-profile` 选用 bundle——fork 此前因其"需要被排除的 api/session-controller 面"而延期。插件管理橱窗将 `inspector-profile` 列为一行，该行需要真实内容。

## 决策

三个包全部按上游包名移植进 `packages/experimental/`，`locale/*.json` 双语与 `icon.svg` 逐字节沿用上游。session-controller 依赖映射到 fork 自有面：浏览器侧会话/事件状态由 `packages/client/runtime` 承载，线路侧由 `packages/api/remotes` + `packages/api/gateway` 承载——此前的延期阻塞是名称错位，不是接缝缺失。

`inspector` 保留 Host 与 Client 双编译面（`tsconfig.host.json`/`tsconfig.client.json` 引用）；`session-inspector` 与 `inspector-profile` 为 Host 面包。`inspector-profile` 已注册进 `OPTIONAL_BUNDLES`（供插件管理橱窗开关）与 `apps/cli` 依赖；不进入任何出厂默认组成。

## 已考虑的替代方案

- **维持延期**被否决：owner 指令为同步全部上游插件功能，映射后的接缝足以承载该依赖。
- **克隆上游 session-controller**被否决：把读取改接到 `client/runtime` 与 `api/remotes` 保留了 fork 的数据面主权，而不是新增平行 API 面。

## 测试

各包规格随源码一并移植（`inspector` 37 份、`session-inspector` 28 份、`inspector-profile` patch 规格）；三个编译面 `tsc --noEmit` 全部干净。验证记录见 `.rc2-work/logs/inspector-port.log`——原移植代理中断后，注册由收尾工作直接补齐。

## 后果

开发者工具组以可选的 experimental 包落地，发布组成保持不变，而 inspector 各面可以经插件管理橱窗开关。会话与线路读取走 fork 自己的 `client/runtime` 与 `api/remotes` 接缝——没有引入平行的 controller 面。
