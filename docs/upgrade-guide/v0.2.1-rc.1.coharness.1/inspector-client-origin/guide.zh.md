---
kind: upgrade-guide
description: "Inspector Client 启动要求浏览器 origin 符合准入条件，且 bootstrap 数据包含 clientOrigins。"
---

# Inspector Client origin 准入

[English](guide.md) | 中文

## 变更

Inspector Client source 只在 loopback origin 或 Host 的 `clientOrigins` 精确条目上启动。其他页面仍保留**仅 Host** 模式的 NodeJS 诊断底部面板，不提供 Client `ctx.inspector`，也不创建 source collector 或 ingest 重连。本地开发通过 `localhost`、`127.0.0.1` 和 IPv6 loopback 访问时保留 Client 检查能力。

注入的 `__DSH_INSPECTOR__` 值与已鉴权的 bootstrap 响应要求包含 `clientOrigins` 字符串数组。自定义 bootstrap producer 必须提供与 Worker 一致的额外 origin。[包参考文档](../../../../packages/experimental/inspector/README.zh.md)说明 origin 准入与显式的仅 Host 选择参数。

## 迁移

1. 一起升级 Inspector Host、Client 和 DevTools 资源，然后重新加载已有浏览器页面。自定义 bootstrap producer 必须包含 `clientOrigins: []`，或 Host 上配置的精确列表。
2. 可信的本地开发主机名仍需在 Host 的 `clientOrigins` 中保留其精确 origin。浏览器仍须能够访问此 Host 的 loopback Worker 端点；允许列表不为 Client ingest 提供远程转发。
3. 打开底部面板。不符合条件的 origin 会显示 **NodeJS 诊断 · 仅 Host**，不尝试 Client ingest 连接。符合条件的 origin 会显示 Host 与自身 Client；仅 Host 视图排除其他已连接 Client。
