# Agent Note: 文档内容路由交付原字节

Status: implemented

[English](2026-09-15-document-content-identity-bytes.md) | 中文

## 问题

为 web profile 启用 `compression: gzip` 后，runtime 的文档下载变成了被转换的响应：压缩层在重写响应体的同时移除了 `content-length`，而 Gateway 的跨作用域复制在把源流进目标上传之前必须拿到声明大小——于是每个文档都以「did not provide a stable document size」失败。浏览器看到「1 个文档复制失败」，加入对话流程始终无法完成。

## 决策

`/api/documents/content` 是字节恒等路由：响应携带 `cache-control: no-transform`——压缩中间件遵守的 RFC 7234 豁免——因此 `content-length` 与存储字节原样到达每个消费方。Gateway 的复制代理另外在源抓取上请求 `accept-encoding: identity`，即使面对忽略 `no-transform` 的 runtime 响应策略，复制也保持正确。

## 考虑过的替代方案

**对整个 web profile 关闭压缩。** 否决：UI、JSON 与类 SSE 路由上的 gzip 是这次升级的预期收益；只有文件内容路由需要原字节，`content-range` 响应本就已豁免。

**缓冲源响应体后测量。** 否决：它破坏了向目标上传的流式传输，并重复计算 runtime 已知道的大小。

## 结果

跨作用域复制与加入对话在启用 gzip 的 runtime 下正常工作，浏览器下载重新获得用于进度显示的声明长度。这里选择 identity 编码没有代价——用户文档通常已是压缩格式。

## 验证

`packages/host/userdoc-http/tests/loader-composition.spec.ts` 以 `compression: gzip` 启动真实 WebServer，断言内容路由返回 `content-length` 且无 `content-encoding`。`gateway/tests/document-transfer.spec.ts` 钉住源抓取携带 `accept-encoding: identity`。
