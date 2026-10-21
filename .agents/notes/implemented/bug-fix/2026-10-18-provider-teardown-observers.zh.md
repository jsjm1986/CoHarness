# Agent Note: Provider 卸载期间保留消费者清理所需的观察者

Status: implemented

[English](2026-10-18-provider-teardown-observers.md) | 中文

## 问题

消费者可能在其 provider 被卸载时追加最后一个 Session 事件。若 tracker 与服务同时关闭，JSONL 事件监听器和文件句柄会先于消费者清理结束而释放，使事件只存在于内存而没有持久记录。凭据 watcher 也有相关的生命周期要求：Chokidar 在关闭时清除监听器，但挂起的写入稳定性轮询仍可能发出错误。

## 决策

JSONL 插件在存储服务的子 fiber 之外拥有 tracker。provider 卸载先等待服务及依赖消费者完成释放，再释放 tracker，因此消费者清理仍可追加事件，最终 writer drain 也包含这些事件。此顺序适用于 provider 触发的卸载；并发的根释放不为无依赖的兄弟 fiber 建立顺序。应用必须先停止活跃生产者，再释放根。

凭据 provider 关闭新工作接纳，调用 `watcher.close()`，重新附加错误处理器，并等待关闭及已接纳的凭据操作。活跃期间，处理器报告 watcher 错误；关闭后只消费迟到错误，不发布状态或记录日志。保留处理器是为了容纳 Chokidar 的 close promise 无法等待结束的回调。

这些 provider 特定的生命周期落实了[运行时有界清理规则](2026-08-27-bounded-runtime-work-and-teardown-fences.zh.md)。

## 备选方案

**先 drain writer，再释放消费者。** 否决：成功 drain 只覆盖已接纳的事件，不包含消费者在清理时追加的最后事件。

**将 tracker 清理与服务清理并列注册。** 否决：兄弟清理 effect 无法表达所需顺序。

**关闭时移除 watcher 的全部监听器。** 否决：随后没有监听器的 EventEmitter `error` 会作为异常向外抛出，即使 provider 已无法处理该错误。

## 后果

Provider 卸载保留现有 Session 格式与 append 语义，同时保全消费者的最后事件。watcher 处理器在剩余回调生命周期内附着于已关闭的 watcher；它不会重新打开 provider 或接纳工作。两项变更均不保证恢复在已接纳写入 drain 完成前终止的进程。

## 验证

[Loader 清理测试](../../../../packages/session/session-persistence-jsonl/tests/teardown-loader.e2e.ts)在依赖消费者追加最后事件时卸载真实 provider，随后读取文件并检查监听器与句柄释放。存储测试覆盖刷新与失败路径。凭据测试复现关闭时移除监听器及后续错误发出；这是确定性的库生命周期证据，不是原生 Windows 文件系统验收。
