---
kind: upgrade-guide
description: "原生翻译在资源或凭据等待期间拒绝已变化的选定所有者。"
---

# 在准入期间保留原生翻译资格检查

[English](guide.md) | 中文

## 变化

未缓存的原生翻译在等待资源或提供方准备期间，如果原生所有者、模型配置、官方凭据引用或资格变化，会以 `TRANSLATION_UNAVAILABLE` 拒绝。被拒绝的选择不会发出请求，已结束使用的资源额度会返还，已记录的请求保留且不写入结果。已缓存的成功翻译仍可复用。原生翻译报告用途 `translation`，替代默认的 `assistant`；自定义用途校验器和用量报表必须接纳该值。

## 迁移

一起重新构建 LLM 服务、原生 API 扩展、翻译器和 SDK 子代理提供方。更新自定义用途校验器，并确认原生翻译用量记录包含 `translation`。预备流 Consumer 可通过 `stream(options, guard)` 传入可选的进程内 `PreparedLlmCallGuard`。回调必须位于模型输入之外；异步资格检查与同步最终所有者检查有各自的执行时机要求。不需要 Session 代次或数据库迁移。选定原生路由可用后重试翻译。
