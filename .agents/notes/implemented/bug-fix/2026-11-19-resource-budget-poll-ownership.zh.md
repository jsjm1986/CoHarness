# Agent Note：由 Runtime 服务管理排队资源轮询

Status: implemented

[English](2026-11-19-resource-budget-poll-ownership.md) | 中文

## 问题

受管资源服务捕获 Cordis 调用方来确定每次进程或模型操作的来源。一次排队轮询经同一个调用方接收者调度下一次时，每个回调都会增加一层 Cordis shadow。长时间等待可能在更新计时器或获准字节计数时耗尽 JavaScript 调用栈，打断工作区审阅或模型准入。

## 决策

[资源提供方](../../../../packages/context/gateway-runtime/src/resource-budget.ts) 将调用方 Context 传给来源捕获，并通过绑定到 Runtime 所有者的回调进入队列。轮询、完成结算、取消和销毁共用该提供方的可变状态以及原有队列和传输预算。每次注册保留经验证的来源与精确的完成身份。

## 考虑的替代方案

延长排队期限或加大 JavaScript 调用栈仍会留下持续增长的接收者链。从提供方 Context 捕获来源会为调用方作用域内的执行选错权限。修改 Cordis 会影响所有使用调用方上下文的服务消费者。

## 影响

提供方测试在 200 次等待轮询后交付进程许可，并确认该注册只提交一次静止完成。双 Gateway 和 Runtime 夹具在计时操作之间刷新合成节点压力，模拟容量稳定时的定期采样。持续负载与重复轮询回归分别验证。
