# Agent Note：生产环境客户端产物轮询需显式启用

Status: implemented

[English](2026-08-23-production-client-hmr-opt-in.md) | 中文

## 问题

没有开发构建器改写文件时，轮询全部客户端 bundle 会产生周期性文件系统开销。禁用整个 HMR 插件还会移除实时图通道，而已打开页面需要通过该通道获知 Host 插件的启停。

## 决策

Web Bundle 始终挂载图传输。其 `watchArtifacts` 配置只在启动环境包含精确值 `DSH_CLIENT_HMR=1` 时启用 stat 轮询。开发启动在运行 `pnpm run dev:web` 的同时设置该变量。普通启动中的图变化与重连快照保持事件驱动，不读取产物基线，也不创建产物轮询计时器。

包默认值保留自定义组装中的产物监视。发行 Web 组装拥有生产配置，静态组装检查同时拒绝禁用图传输和无条件产物轮询。页面协调由[共享 ClientEntries 控制器](2026-09-23-page-owned-client-entries.zh.md)负责。

安静的图流按照 [SSE（Server-Sent Events）编写建议](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes)发送可配置的保活注释。这些注释维持传输活动，不读取产物、发布图、替换插件或续期权限。捕获的公网流在约 125 秒没有响应字节后结束，与 Cloudflare 文档中的[代理读取超时](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)一致；该时序支持空闲超时推断，不能解释即时连接关闭或后续 WebSocket 故障。

## 考虑过的替代方案

**禁用整个插件。** 这会阻止已打开页面观察插件成员变化，使页面的 Loader 清单陈旧。

**在生产环境轮询产物。** 没有开发构建器时，这仍会增加周期性文件系统开销。

**增加构建器通知协议。** 现有显式启用的轮询已经支持包括网络挂载在内的源码开发，无需另一套协调协议。

## 结果

普通启动拥有 SSE 通道和浏览器传输条目，但不创建产物轮询器。客户端源码变更需要显式开发开关和构建器，或走常规构建与刷新流程。Host 配置重载和页面级图协调不依赖产物轮询。测试证明关闭轮询时的图传输和清理，源码编辑验收覆盖启用路径。

保活注释跳过受背压影响的响应。插件清理停止新写入，并等待每个已接纳响应真正关闭，包括已因失败而开始销毁的响应。图未变化的重连保留活动条目，同时仍允许失败条目重试；连接恢复仍由运行时传输管理。
