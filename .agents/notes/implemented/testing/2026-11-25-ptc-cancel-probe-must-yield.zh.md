# Agent Note：通过会 yield 的写操作探测 PTC 取消就绪，而非即发即弃的 binding

状态：已实现

[English](2026-11-25-ptc-cancel-probe-must-yield.md) | 中文

## 问题

`packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts` 的 "cancels a live program and closes its managed process" 在托管 Windows 上烧满 180 秒超时——`{}` 变体（master run 45322944681）和 `{"timeoutMs":null}` 变体（分支 run 45481979435）都挂过，而同文件内相邻的 teardown 用例在同一 runner 上以数百毫秒完成。被测程序是 `void tools.enter({}); for (;;) {}`，宿主在 abort 前等待 binding 的 `entered` 信号。即发即弃的 invoke 根本到不了宿主：子进程的 RPC 写排入 libuv 队列，而同步热循环在事件循环冲刷之前就启动了。POSIX libuv 对小型管道写入内联冲刷，所以该 spec 在 macOS 和 Linux 上稳定通过；Windows overlapped 管道写需要一次 loop 迭代，`entered` 是否触发成了每次 spawn 抛硬币。测试挂在 `await entered.promise`——取消 teardown 根本未被到达——跨 run 挂的变体互换证实了竞态在探针而非进程终止。

## 决策

将就绪探针换成同文件兄弟测试 "retains console output when a non-yielding program is canceled" 已验证的模式：程序在进入热循环前同步写就绪文件，宿主轮询该文件后再 abort。就绪判断不经过任何 binding 往返，程序启动与探针可见性之间不存在事件循环冲刷。被取消的对象不变——取消中途被杀的活热循环进程——abort 结果断言逐字节相同。探针处的注释记录了 yield 要求，防止该模式被简化回即发即弃调用。

## 备选方案

- **仅用 `await tools.enter({})` 做探针**——await 确实会 yield 并冲刷，但宿主观察到的是调用而非程序恢复执行；在响应返回前落地的 abort 取消的是挂起的程序而非热循环中的程序，削弱了该测试要钉住的契约。
- **产品层为即发即弃 invoke 提供冲刷保证**——无法实现：从不 yield 的程序无法传输，这是协作式调度的固有属性而非 PTC 缺陷。
- **把挂起当作 Windows Job runner 终止缺陷**——被证据排除：`{}` 变体在同一 run 内 612ms 通过，`disposes active programs`（同样 teardown、await 探针）在 master 双变体通过，且 `WindowsJobOwner` 的 wedge 路径产生快速失败而非无界挂起。

## 后果

取消契约——abort 关闭受管进程并返回调用方原因——在每个平台上都继续由真正热循环的程序钉住。未来任何需要观察程序越过不可返回点的探针都需要同样的属性：在阻塞构造之前同步写下的证据，绝不用冲刷依赖程序即将扼杀的事件循环的 in-flight RPC。相关：[Windows teardown 预算余量](../bug-fix/2026-11-24-windows-teardown-budget-headroom.zh.md)覆盖同一 lane 内独立的 taskkill 投递预算类别。
