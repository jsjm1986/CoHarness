---
kind: upgrade-guide
description: "SDK 客户端在开始关闭后拒绝新工作，并保留失败的子进程清理以供重试。"
---

# 重试失败的 SDK 运行时清理

[English](guide.md) | 中文

## 变更

TypeScript `HarnessClient.close()` 与 `DeepSeekHarness.close()` 可以重试其原始子进程的失败清理。未完成和已成功的尝试仍然共享。Python 串行执行 close 尝试，并在终止或退出确认失败时保留子进程。配置的 `shutdown_timeout_seconds` 也限制强制终止后的等待。

两套 SDK 都在开始关闭时永久拒绝新工作。Python 即使仍在等待 shutdown 确认，也会拒绝新的 `request()` 和 `notify()`；高层 close 失败后也不能再次 `start()` 或开始轮次。此前，终止失败可能导致无法继续清理，Python 可能在关闭期间接受新工作，或在强制结束后无限等待。

Python 使用有界 stdin 写入队列，因此运行时停止读取不能阻塞请求时限或进程终止。`max_output_bytes` 同时限制排队与正在写入的帧。非法请求超时在发送前拒绝。从通知过滤器关闭时跳过等待自身读取线程。

## 迁移

1. 等待 TypeScript `close()` 或调用 Python `close()`。发生拒绝时按清理未完成处理，并保留同一实例。解决进程控制失败后，重试该实例的 `close()`；创建另一运行时不能完成原始清理。
2. 在前一运行时退出后，通过新实例提交后续工作。不要复用已经开始关闭的实例。
3. 在 TypeScript 中设置正数 `shutdownTimeoutMs`、`disposeEofGraceMs`、`disposeGraceMs`，或在 Python 中设置 `shutdown_timeout_seconds`，以满足所需关闭时限。Python 的 `None` 仍然允许无限等待。
4. 确认原进程退出后，才能认为其资源占用已经释放。SDK 协议消息与存储的 Session 数据无需迁移。
5. 重试消息前先处理 Python 输出队列准入错误。`notify()` 与 RPC 响应将帧加入队列；原生写入失败会通知未完成的传输消费者。若进程退出后写入线程仍未结束，保留原客户端，待其可结算后重试 `close()`。重试超时的修改操作前，先确认其实际效果。
