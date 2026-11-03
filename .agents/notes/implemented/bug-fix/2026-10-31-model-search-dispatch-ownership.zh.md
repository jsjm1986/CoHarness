# Agent Note：独立模型搜索保留准入归属直到 HTTP 派发

Status: implemented

[English](2026-10-31-model-search-dispatch-ownership.md) | 中文

## 问题

独立 Messages 和 Sonar 搜索可以先等待模型容量，再等待凭据。只保留获批许可，不能证明提供者仍持有该请求。在解析凭据前检查模型策略要求，也可能使组合已经要求受管路由后仍发出原始 HTTP。

## 决策

`registerModelSearch()` 在准入前捕获发起资源提供者和 Session。同步归属检查比较原始 Cordis Service 身份，并要求独立路由继续获准。它在准入后运行，并传给 `ModelSearchImplementation.independent`，供异步准备后检查。两个原生提供者都在无密钥请求记录前后、现有 HTTP 入口之前调用。所有者变化或新增必需策略时，拒绝旧请求，并通过原提供者归还未使用的许可。

## 考虑过的替代方案

**等待后查询替代提供者。** 替代者没有接收原请求，不能继承其许可。

**只在模型准入后检查。** 凭据解析在 HTTP 前引入了另一次异步等待。

**策略缺失时恢复独立派发。** 必需的用户策略必须在恢复前拒绝请求，包括默认模型路由。

## 影响

调用方恢复准入或授权后应重新搜索。成功的受管与独立结果、Session 请求字段、凭据和配置中的模型默认值保持不变。记录回调仍可拒绝派发，已经记录的尝试保持可重建。[LLM 归属指南](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/model-resource-ownership/guide.zh.md)负责普通和准备后模型流，不负责这些独立传输。

## 验证

两个提供者的测试覆盖排队准入或解析凭据期间移除、替换、新增资源准入和安装模型策略。原生受管操作覆盖发起 Session 归属与必需用户策略缺失。真实 Loader/Agent/文件凭据[示例](../../../../packages/web/web/tests/fixtures/model-search-owner.mjs)仅发送本地 HTTP，验证被拒绝请求不派发、不生成请求事件，保留原许可，完成新请求重试且不记录密钥。
