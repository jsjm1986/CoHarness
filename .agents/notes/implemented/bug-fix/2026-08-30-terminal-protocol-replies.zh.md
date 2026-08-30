# Agent Note：在 PTY 发送前排空终端协议应答

Status: implemented

[English](2026-08-30-terminal-protocol-replies.md) | 中文

## 问题

Unix PowerShell 会在启动期间以及持有 PTY 时查询终端光标位置。持久会话此前把这些字节当作普通输出处理，因此协议应答可能与调用方输入或就绪检查竞争。在 macOS 和 Linux 上，这种竞争会造成过早的 `inferred_idle`、启动输出不完整以及偶发的空 viewport。

## 决定

`dsh-terminal-bash` 现在把原始 PTY 输出送入一个零滚动的 `@xterm/headless` 实例，仅用于维护终端协议状态。生成的应答通过同一个终端句柄串行写入；一个解析写入进行期间到达的原始数据会合并；每次发送调用方输入前都会排空解析器和应答队列。就绪检测会在并发协议活动后重新检查前台进程，并在待处理应答结算前保留发送所有权；传输失败或 teardown 时关闭解析器。PowerShell 启动使用一个绝对 `timeoutMs` deadline，并只接受后端的 `stdin_read` 证据，不把回显的提示符源码当作就绪。

## 验证

terminal-bash session suite 覆盖拆分光标查询、应答顺序、队列合并、解析器与应答失败、超时所有权、取消、teardown 和过期检查。index 与真实 shell suite 覆盖有界的 PowerShell 启动循环以及现有 bash 行为。实现保留原有 sanitizer、输出限幅、sandbox policy 和进程检查器 seam。

## 备选方案

**在逐行 sanitizer 中解析光标查询。** 拒绝，因为就绪输出与终端控制状态的所有权和缓冲要求不同。

**在每个输出回调中立即写协议应答。** 拒绝，因为并发写入可能越过调用方输入，并且高流量输出会为每个数据块创建解析任务。

**为 PowerShell 使用独立 PTY backend。** 拒绝，因为协议状态、取消、限幅和 teardown 都属于共享终端会话 seam。

## 后果

Unix PowerShell 能收到交互宿主所需的协议应答，调用方输入不会越过这些应答。解析器是内部控制面组件；返回输出仍然有界、经过清理并按行组织。全屏备用缓冲区交互仍不属于 backend 契约。
