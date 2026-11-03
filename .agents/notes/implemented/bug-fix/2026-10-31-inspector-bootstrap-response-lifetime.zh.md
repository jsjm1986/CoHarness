# Agent Note：Inspector 引导等待归响应连接持有

Status: implemented

[English](2026-10-31-inspector-bootstrap-response-lifetime.md) | 中文

## 问题

Node `IncomingMessage` 可以在请求体结束后发出 `close`，而浏览器仍在等待响应。把该事件当作取消，会使 Inspector 引导在 HTTP 承载方读完请求体后、Worker 就绪前返回 `503`。从不结束该流的内存适配器会隐藏此故障。

## 决策

[引导处理器](../../../../packages/experimental/inspector/src/host/plugin.ts)持有响应，直到启动完成或响应连接关闭。请求体完成不会结束等待。响应关闭只放弃该浏览器的等待，之后不再写入。Worker 启动及其资源许可继续归 Inspector 服务持有。流式前缀分派器已经提供解析后匹配的请求 URL，因此私有处理器要求该 URL，而不提供回退值。

## 考虑过的替代方案

**在请求 `close` 时取消。** 这会混淆已读完的入站字节与已关闭的响应连接。

**一个浏览器离开就取消共享 Worker 启动。** 其他浏览器和 Host 仍然依赖该服务。

**响应销毁后再返回 `503`。** 已断开的浏览器无法收到回复，写入还会改变处理器不再持有的响应。

## 影响

存活的浏览器在就绪后收到引导数据，或在启动失败后收到 `503`。Client 取消只结束其网络请求，不改变 Host 就绪状态。测试 Fetch 适配器在中止时关闭流两端，并像浏览器请求一样拒绝。路由鉴权和引导字段保持不变。

## 验证

原生 HTTP 测试在释放启动准入前读完整个 GET 请求体，验证不提前发送头部、存活浏览器最终收到 `200`、断开后不再写入，以及服务继续持有启动。真实 Loader/Web/Connection [示例](../../../../packages/experimental/inspector/tests/fixtures/startup-owner.mjs)使用真实 Worker 记录这两种情形；Node 22 和 24 运行同一构建产物会话记录。
