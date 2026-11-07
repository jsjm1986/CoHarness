# Agent Note: SSH 文本流在开始消费时分配

Status: implemented

[English](2026-11-03-ssh-text-stream-allocation.md) | 中文

## Problem

向尚未开始的异步生成器调用 return 或 throw，不会进入其函数体或执行清理。先预留辅助程序迭代器再返回生成器，会在调用方丢弃未读取的可迭代对象时留下无主预留。反复丢弃读取操作可能耗尽连接的有界文本流名额。

## Decision

[SSH 文件系统](../../../../packages/ssh/fs-ssh/src/index.ts) 在生成器内部的第一次拉取时预留辅助程序迭代器，并在预留前检查取消。未开始迭代的调用方不持有远端句柄；开始后，读完或提前结束仍沿用现有的辅助程序清理。文件和准入错误在迭代期间报告，与本地流式读取实现一致。

## Alternatives considered

**保留提前预留并依赖生成器的 finally。** 语言不会在尚未读取的生成器收到 return 或 throw 时执行该代码块。

**提高辅助程序上限。** 更大的上限只能推迟耗尽，不能释放被丢弃的预留。

## Consequences

未使用的可迭代对象不占辅助程序名额，也不需要额外的取消监听器或包装状态。消费方必须在迭代处捕获错误，而不能仅捕获返回可迭代对象的 Promise。辅助程序协议和容量上限保持不变。[转发回滚](2026-10-31-ssh-stream-forwarding-cancellation.zh.md) 和[辅助程序清理归属](2026-10-31-ssh-helper-cleanup-ownership.zh.md) 分别管理传输和关闭资源。

## Verification

实现测试覆盖首次拉取前的 return、throw 和取消，以及正常读完和提前停止。[可运行的 Loader 示例](../../../../packages/ssh/fs-ssh/tests/stream-lifecycle.expected.e2e.ts) 丢弃超过辅助程序上限数量的未读取迭代器，再通过真实辅助程序占满并释放原有名额。示例还观测正常文本、陈旧版本拒绝和释放时私有目录的移除。
