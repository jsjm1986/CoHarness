# Agent Note：Inspector fetch 采集跟随其所属生命周期

Status: implemented

[English](2026-11-03-inspector-fetch-retirement.md) | 中文

## 问题

独立的 Inspector 插件可以观察同一个全局 fetch。它们的卸载顺序与安装顺序无关；恢复保存的包装函数可能重新启用已卸载插件的采集。原生请求也可能在采集停止后才完成。

## 决策

每个 [fetch 包装函数](../../../../packages/experimental/inspector/src/host/inspection/network.ts) 保留自己的取消信号和前驱属性描述符。停止操作同步结束采集，取消 clone reader 并等待其结束。当前包装函数恢复最近仍有效的前驱及其属性；无关的替换实现保持不变。保留的已停止包装函数直接转交调用方的原始参数，不再记录。迟到的原生响应和错误保持调用方所属的结果，不能重新启动采集。

## 考虑过的替代方案

**要求按安装顺序的逆序卸载。** 独立的 Cordis 应用和并发插件清理不提供这种顺序保证。

**维护进程级观察器注册表。** 每个包装函数已经有明确的所属对象和前驱；可变单例会增加另一套生命周期。

## 影响

停止采集保留正在进行的原生请求，以及已经返回的响应的取消行为。Worker 终止和资源确认继续遵循其[独立的归属规则](2026-10-29-inspector-resource-completion.zh.md)。

## 验证

确定性用例覆盖三个观察器的所有卸载排列、保留的引用和停止后的原生结果。真实 Loader [示例](../../../../packages/experimental/inspector/tests/fixtures/fetch-retirement.mjs) 运行独立的 Web 组合，完成原生 HTTP 请求，并在两种卸载顺序中观察 Worker 退出和 fetch 的精确恢复。
