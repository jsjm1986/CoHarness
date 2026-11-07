# Agent Note: Native search owns model admission

Status: implemented

[English](2026-10-24-native-search-model-admission.md) | 中文

## Problem

DeepSeek 原生搜索通过私有 HTTP 执行 Messages 模型请求。它不经 LLM 服务派发，因此绕过节点模型准入，还可能在提供方移除后继续运行。

## Decision

注册后的提供方在等待 execution 模型许可前捕获发起 Session，获准后解析当前设置与凭据，将请求记录到该 Session，并持有许可直到响应处理或取消结束。缺少必需准入时拒绝 HTTP；取消后的迟到许可会释放，不发送请求。

插件持有的控制器取消排队和活动搜索。卸载等待已接受工作，包括许可释放。提供方与释放均失败时保留两个原因。独立组合可不挂载预算，导出的传输类仍是独立 HTTP 实现。此机制管理资源归属，不将原生协议转换为 LLM adapter。

## Alternatives considered

**只计入 LLM 服务调用。** 原生 Messages 推理采用不同传输，仍消耗模型请求容量。

**收到响应头就释放。** 响应体处理和取消仍属于活动操作。

**取消后丢弃迟到许可。** 返回的许可仍占用记账，必须等待释放。

## Consequences

原生搜索会在节点上限下排队或被拒绝。排队期间的设置变化影响派发，移除会等待已接受搜索。包显式声明 resource-budget peer。模型消息与端点选择保持既有表示。

## Verification

真实 HTTP 负向对照证明原实现即使挂载拒绝预算仍会请求 Messages。测试覆盖已捕获 Session 的日志、队列与响应体归属、caller/provider/budget 取消、迟到许可清理与组合失败。两个改动模块满足逐文件覆盖要求，注册文件的豁免已移除。正式 headless 回放要求真实 Messages 端点收到请求时存在活动 execution 许可，同时保持既有记录输出。此前的普通 Node 构建因未获准便发送请求而在相同断言上失败。
