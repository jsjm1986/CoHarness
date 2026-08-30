# Agent Note: 保证 token-meter client 导入在源代码测试中可解析

Status: implemented

[English](2026-08-30-token-meter-client-source-alias.md) | 中文

## Problem

客户端会话代码现在会从 `@deepseek-ai/dsh-token-meter/client` 执行 `deriveTurnTokenUsage`。该包导出指向构建生成的 `lib/types/client.js`，而干净 checkout 在构建前没有这个文件；因此源代码平面 Vitest 会在运行测试前失败，只有带有旧构建产物的本地工作区可以通过。

## Decision

在 `tsconfig.base.json` 中为 `@deepseek-ai/dsh-token-meter/client` 增加精确路径条目，指向 `packages/llm/token-meter/src/client.ts`。这个源代码平面 alias 遵循现有 client 子路径 alias；发布消费者仍使用包导出及其构建产物。

## Verification

使用源代码解析器运行客户端会话和 token-meter focused 测试已通过；在干净安装 checkout 中，串行 macOS sandbox parity 的原始解析失败由该 alias 消除。Typecheck、lint、包路径、runtime closure 和构建包检查继续通过。

## Alternatives considered

**在源代码测试前构建所有包。** 拒绝，因为源代码平面测试不应依赖被忽略的构建产物，而且受影响的包在构建前也应能够独立验证。

**让包导出直接指向源代码。** 拒绝，因为发布消费者需要生成的 `lib/types/client.js` 入口，包导出必须继续适用于 artifact。

## Consequences

源代码测试不再依赖被忽略的构建输出。包导出保持不变，因此 artifact 消费者仍使用同一个生成的 client 入口。
