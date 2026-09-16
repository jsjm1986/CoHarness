# Agent Note：Windows inspector 释放其 koffi 分配

状态：implemented

[English](2026-09-16-windows-inspector-frees-koffi-allocations.md) | 中文

## 问题

`windows-inspector.ts` 经 `koffi.alloc` 分配非托管内存——每次进程表快照一个 `PROCESSENTRY32W`、每次 `processState` 调用四个 `FILETIME`——且从不释放。`koffi.alloc` 是裸 `calloc`，返回值是 bigint 包装的指针、无 GC finalizer，因此每次调用都泄漏：每次快照约 568 字节、每次进程状态读取 32 字节，挂在约 25ms 的 teardown/wait 轮询路径上。

## 决策

每个 `allocNative` 分配现在都在覆盖所有 return 与 throw 路径的 `finally` 中经 `koffi.free` 释放——枚举循环内一层 `finally`，四个 `FILETIME` 读取外一层。

## 考虑过的替代方案

**跨调用保活稳定 buffer。** 否决：inspector 的按次分配开销低，缓存原生 buffer 反而引入调用方不需要的所有权问题。

**用有界池兜底。** 否决：池同样需要释放纪律，只是推迟同一个修复。

## 后果

Windows 上的进程检查不再增长非托管内存。对 bigint 包装指针调用 `koffi.free` 是 `koffi.alloc` 的文档化释放路径，后续 inspector 加入更多原生读取时可复用同一模式。

## 验证

Windows 专属测试套件（`windows-inspector.spec.ts` 的 `win32` 块）在 Windows CI lane 上跑真实 koffi 绑定；释放纪律位于 `try/finally` 内，提前返回与错误路径释放方式一致。
