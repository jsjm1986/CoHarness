# Agent Note: Web 启动提供 AbortSignal 静态工厂兼容性

Status: implemented

[English](2026-08-25-abort-signal-webview-compat.md) | 中文

## 问题

Web 客户端在组合传输与生命周期取消信号时使用 `AbortSignal.any()`。部分 Android WebView 提供了 `AbortController`，却没有较新的 `any`、`timeout` 或 `abort` 静态工厂，因此移动端请求在到达 Gateway 之前就会以 `AbortSignal.any is not a function` 失败。

## 决策

Web 启动内核会在预取或激活动态客户端 entry 之前，为缺失的 AbortSignal 静态工厂安装小型兼容实现；原生实现保持不变。`any` 实现转发第一个中止原因，并在结算后移除全部监听器；timeout 实现会在取消时清理定时器；abort 实现返回已经中止的信号。兼容代码只负责浏览器 API 可用性，请求取消与传输终止仍由现有调用方负责。

## 考虑过的替代方案

- **要求升级 Android WebView。** 否决：托管 Web UI 无法可靠控制内嵌 Shell 使用的系统 WebView 版本，而该错误会阻断普通导航和模型选择。
- **逐个替换所有 `AbortSignal.any` 调用。** 否决：浏览器侧与动态加载包会重复实现信号合并，监听器清理和原因语义容易分叉。
- **让 Gateway 隐藏该错误。** 否决：异常发生在浏览器中、HTTP 请求发送之前，服务器无法修复客户端 API 缺失。

## 结果

较旧但仍受支持的 Android WebView 可以打开 Web UI、建立连接，并在有界 RPC 中使用取消，而不会再出现该内部 TypeError。具备原生工厂的浏览器继续使用平台实现。兼容层不承诺支持缺少底层 `AbortController` 或 `fetch` API 的浏览器。
