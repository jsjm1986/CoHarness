---
kind: upgrade-guide
description: "Inspector 引导等待在正常入站请求完成后继续，在响应连接断开时结束。"
---

# 保持 Inspector 引导等待直到就绪

[English](guide.md) | 中文

## 变更

已鉴权的 Inspector 引导在 HTTP 承载方读完请求体后继续等待 Worker 就绪。存活浏览器会收到带引导数据的 `200`，或在启动失败后收到 `503`。此前，正常入站请求完成可能在 Worker 就绪前返回 `503`。

响应连接关闭只放弃该浏览器的等待，销毁后不再写回复，共享启动和资源记账仍归服务持有。鉴权、URL 和引导字段保持兼容。

## 迁移

1. 部署完整匹配的 Inspector 包和 Worker 构建产物。不需要配置或数据迁移。
2. HTTP 承载方可以读完请求体，而不结束等待中的引导响应。响应关闭必须传播 Client 断开。
3. 验证排队启动期间打开的浏览器在就绪后收到引导数据，离开该浏览器不会取消共享启动。参见 [Inspector 参考](../../../../packages/experimental/inspector/README.zh.md)。
