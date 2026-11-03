---
kind: upgrade-guide
description: "进程及终端分配在准入期间遇到资源提供方被撤销或替换时拒绝执行。"
---

# 资源提供方替换后重新请求进程分配

[English](guide.md) | 中文

## 变更

`ctx.subprocess.spawn()` 与 `spawnTerminal()` 保留准许其请求的资源提供方。若该提供方在物理启动派发前被撤销或替换，包括 SSH 预备与流连接等待期间，操作以原因值为 `unavailable` 的 `ResourceAdmissionError` 拒绝，并将未使用的许可归还原提供方。独立请求若在分配前出现托管准入，也会拒绝。此前这些请求可能依靠过期准入或在没有许可时启动子进程。

此变化影响在分配待决期间替换 `resourceBudget` 或其必需标记的应用。已有子进程保留清理责任。提供方签名、配置和持久化数据不变。

本地提供方在普通进程的参数／宽限期校验、终端的空程序校验或目标环境校验于启动前拒绝时归还未使用的容量。程序名、参数、目录和环境条目中的空字节保留原有的 `ERR_INVALID_ARG_VALUE` 错误。后续有效请求可以使用该槽位；物理清理无法确认的失败仍保留不确定占用。

## 迁移

1. 将匹配的 `@deepseek-ai/dsh-subprocess`、`@deepseek-ai/dsh-subprocess-local` 与 `@deepseek-ai/dsh-subprocess-ssh` 产物与 Runtime 载荷一起部署。保留[托管资源启动流程](../managed-resource-admission/guide.zh.md)。
2. 等待两种分配 API。收到 `unavailable` 拒绝后，恢复资源准入并发起新的分配请求；不要把旧许可转交给另一个提供方。
3. 异步提供方在入口捕获 `captureAdmissionCheck(spec)` 并在启动派发前调用。确认回滚后，使用 `rejectAfterCleanup(failure)` 归还准入并保留原始失败；否则保留不确定占用。
4. 确认排队期间替换提供方不会启动子进程，原许可得到归还，新请求可以通过替代提供方。参见[子进程参考](../../../../packages/subprocess/subprocess/README.zh.md)。
