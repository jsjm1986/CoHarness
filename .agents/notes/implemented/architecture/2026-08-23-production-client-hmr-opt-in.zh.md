# Agent Note: 生产环境客户端 HMR 采用显式启用

Status: implemented

[English](2026-08-23-production-client-hmr-opt-in.md) | 中文

## Problem

Web 组合在每次启动时都挂载 `dsh-client-hmr`。即使没有开发构建 watcher 改写 bundle，Host 半边仍会轮询每个客户端 bundle 并暴露 SSE 路由，使普通生产会话承担周期性的文件系统工作。

## Decision

Web Bundle 只有在启动环境包含精确值 `DSH_CLIENT_HMR=1` 时才启用 `client-hmr` Loader 行。开发启动在运行 `pnpm run dev:web` 重建客户端产物的同时设置该变量。现有 profile patch watcher 独立保持启用，因此普通配置编辑仍然支持实时重载。HMR 包保留现有生命周期和轮询实现，由组合决定其 Fiber 是否存在。

## Alternatives considered

**始终挂载该行。** 否决：空闲的开发功能仍会在每个生产进程中周期性执行 stat 轮询并占用一个路由。

**增加运行时 heartbeat 或构建器到 Host 的通知通道。** 否决：这会为仅开发期功能增加第二套协调协议和常驻控制面。

**完全关闭 HMR。** 否决：本地客户端开发仍需要源码编辑后的重载，现有浏览器验收测试也覆盖这一行为。

## Consequences

普通 Web 启动不会创建客户端 bundle 轮询器、HMR SSE 路由或浏览器 HMR entry。开发者必须显式设置 `DSH_CLIENT_HMR=1` 并运行 `pnpm run dev:web`。Web 表层提示词以及 CLI、Bundle 参考文档都会说明这一更新约定。未设置开关时，客户端源码编辑必须走正常构建和刷新页面路径。
