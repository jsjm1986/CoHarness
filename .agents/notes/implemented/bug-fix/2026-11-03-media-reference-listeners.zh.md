# Agent Note：文件预览的取消监听器随每次读取结束

Status: implemented

[English](2026-11-03-media-reference-listeners.md) | 中文

## 问题

`/api/file` 处理器为每次有字节上限的文件系统读取注册一个套接字关闭监听器。GET 和 HEAD 请求完成后，持续连接的套接字仍然存在，单独使用 `once()` 会把监听器保留到连接关闭。重复预览会累积 AbortController，并超过 Node 的监听器告警上限。

## 决策

[处理器](../../../../packages/api/gateway/src/media-references.ts) 保留本次取消回调的精确引用，在路径解析、元数据读取、内容读取或失败结束后的 `finally` 中移除它。读取期间关闭套接字仍会取消提供器操作。其他所有者的监听器不受影响。

## 考虑过的替代方案

**提高监听器上限。** 这会隐藏告警，并继续保留已结束的操作。

**使用请求关闭事件。** 传入的 GET 请求可能先于提供器读取结束，该事件不能代替已接纳读取的套接字断开信号。

## 后果

经过认证的读取规则、字节上限、状态码和完整文件响应仍由[文件展示决策](../feature/2026-09-08-file-display-through-filesystem.zh.md)定义。取消监听器的归属随处理器结束，不依赖 HTTP 持续连接的存活时间。

## 验证

四个定向用例检查 GET、HEAD、文件系统拒绝和意外提供器错误后的监听器释放。真实 Loader [示例](../../../../packages/api/gateway/tests/fixtures/media-reference-lifetime.mjs) 通过 Connection 认证，在同一个原生 HTTP 持续连接上验证十六次文件预览。已完成请求不保留读取取消监听器。
