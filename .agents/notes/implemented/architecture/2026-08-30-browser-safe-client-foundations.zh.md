# Agent Note: Centralize browser-safe client primitives

Status: implemented

[English](2026-08-30-browser-safe-client-foundations.md) | 中文

## 问题

浏览器客户端可能运行在不安全的 HTTP 来源或 worker 中，此时仅安全上下文提供的 `crypto.randomUUID` 不可用。分散的回退还可能产生弱标识符和重复的字节编码器。用户可见的中日韩文字与拉丁文字也需要一致的间距，但不能改变代码、diff、终端或其他字面输出。

## 决策

`@deepseek-ai/dsh-util-crypto` 负责跨运行时的 `randomUUID` 与有界 `bytesToBase64` 原语。UUID 使用 `crypto.getRandomValues` 生成 RFC 9562 v4，不提供不安全的伪随机回退。浏览器侧的会话、工作区、附件、RPC、命令、代理和 LLM 请求消费方统一使用该包；客户端 bundle 将其视为无状态的安全内联工具，因此普通 HTTP 客户端不需要额外的模块表条目。Web 基础样式对正文启用 `text-autospace: normal`，并用 `no-autospace` 排除字面量和代码类表面。

## 考虑过的替代方案

**继续调用 `crypto.randomUUID` 并要求 HTTPS。** 不采用：本地 HTTP 部署和 worker 都是支持的运行环境。

**回退到 `Math.random` 或时间戳。** 不采用：标识符会失去密码学唯一性保证，碰撞也更难诊断。

**对所有元素启用自动间距。** 不采用：代码、diff、终端输出以及搜索/读取载荷是必须保持字面值的数据。

## 影响

客户端标识符和附件编码拥有一个经过测试的实现，并能在支持的浏览器环境中使用。现在宿主侧强制标识符失败的测试直接拦截该所有者，因此生命周期失败覆盖不会悄悄退回全局 Web API。新增 CSS 改善混合文字正文，同时通过显式字面量选择器保持源文本的渲染不变。该工具要求环境提供可用的 Web Crypto `getRandomValues`；不具备该能力时会明确失败，而不是静默降低安全性。

## 测试

工具测试覆盖 v4 形状、唯一性、不具备安全上下文方法的情况，以及空数据、二进制和大块 base64 输入。Web 样式测试覆盖正文规则和字面量输出排除项。连接、运行时、会话和附件消费方测试继续通过共享工具覆盖这些调用。
