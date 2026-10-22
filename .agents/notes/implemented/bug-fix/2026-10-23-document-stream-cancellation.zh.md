# Agent Note: 释放上传资源前取消挂起的文档流读取

Status: implemented

[English](2026-10-23-document-stream-cancellation.md) | 中文

## Problem

公开文档 `save` 操作接受 AbortSignal，但仅在 `reader.read()` 前检查不能撤回停滞的 producer。操作及其 `.part` 文件会一直存活，直到 producer 提供下一块数据或失败。

## Decision

[`saveDocFile`](../../../../packages/attachment/userdoc-local/src/store.ts)将取消绑定到已获取的 reader。abort 取消挂起的读取；操作在读取后和发布前复核取消，等待 reader 取消，释放锁，并在失败时删除临时文件。[上传文档功能](../feature/2026-08-14-user-uploaded-documents.zh.md)继续拥有文档引用和当前可恢复上传协议。

## Alternatives considered

- **竞速读取并放弃其 promise。** 不采纳：这会把 producer 和锁定的 reader 留在清理之外。
- **只在数据块之间轮询 signal。** 不采纳：停滞的 producer 不会提供下一个检查点。

## Consequences

取消可以不等下一块 producer 数据就完成。producer 取消仍是协作式：异步 `cancel()` 清理会被等待到完全停稳。该行为适用于公开流式 `save` API；不改变主要的可恢复上传协议、文档 id 或模型上下文。

## Verification

[存储回归](../../../../packages/attachment/userdoc-local/tests/store.spec.ts)使用零缓冲流和显式读取屏障。它只在读取开始后 abort，观察 producer 的取消原因，要求 save 失败，并验证临时目录为空。已有的预先 abort、数据块边界取消、冲突和大小限制用例仍被覆盖。
