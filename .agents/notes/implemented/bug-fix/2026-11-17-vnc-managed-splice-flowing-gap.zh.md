# Agent Note: VNC managed splice 在 reader 到 pump 的交接期暂停两侧 socket

Status: implemented

[English](2026-11-17-vnc-managed-splice-flowing-gap.md) | 中文

## 问题

`managedHandshake` 的 `ByteReader` 实例在 client 与 upstream socket 上挂了 `data` 监听，使两者进入 flowing 模式。握手 resolve 后，`finally` 摘除 reader，随后 `serveStream` 跨多个 await 跳数(`throwIfAborted`、upstream-residual 写入、`pumpRfb`）才安装 pump 自己的 `data` 监听。落在该窗口内的字节会命中一个零监听的 flowing 模式 socket，被永久丢弃——client 输入与 server 帧同此命运。

seatbelt lane 的 `splices a credential-managed stream and drops view-level input` 连续两轮命中该窗口：browser 的 `KEY_EVENT ‖ FB_UPDATE_REQUEST` 写入落在 reader 摘除之后、pump 挂载之前，被过滤的请求从未到达 upstream,流保持静默。用 `vi.waitFor` 容忍该写入没有用——字节是丢了，不是迟到。

## 决策

`managedHandshake` 在其 `finally` 中于 reader 摘除之前 pause 两个 socket:paused socket 缓存到达的字节而非将其发向虚空。`serveStream` 在 `pumpRfb` 挂好监听后立即 resume 两个 socket，缓存的字节于是经由 pump 的过滤器排空。`managedHandshake` 的 JSDoc 把 pause 写进契约——调用方装好监听后必须自行 resume 每个 socket。

residual 路径不变:reader 在 ClientInit/ServerInit 之后多消费的字节仍经 `clientResidual`/`upstreamResidual` 送达，`pumpRfb` 先把它们回放进过滤器，保持了它们先于 paused-socket 积压字节的到达顺序。

## 后果

- 字节不再可能落在 reader 摘除与 pump 挂载之间；无论事件循环如何调度，splice 双向无损。
- 非 managed 路径不受影响：没有 `passwordRef` 就从未挂过 reader,socket 从未进入 flowing,`pumpRfb` 仍先于数据挂载。
- 失败路径无需 resume:`serveStream` 的 `finally` 销毁传输，paused socket 不会泄漏。
- spec 的 `vi.waitFor` 保留为投递延迟容忍；新的确定性回归断言 paused-socket 字节能存活到 `resume()`。

## 已考虑过的替代方案

- 在交接期保留一个 `data` 监听、交接后回放进 pump——否决：在 `clientResidual` 之外引入第二个缓冲所有者，顺序论证更难，而 `pause()`/`resume()` 正是为监听换绑设计的流原语。
- 返回 `detach()` 句柄让调用方在装好 pump 后再关 reader——否决：颠倒了"谁打开谁关闭"的纪律，且迫使 pump 挂载必须发生在握手生命周期内。
- 把丢失归为测试时序——被红绿证据否决：去掉 `pause()` 后，确定性 spec 每次都丢帧，与 CI 签名完全一致。

## 验证

- `packages/remote-desktop/remote-desktop-vnc` 套件——本地 66/66，含新增的 `keeps post-handshake bytes buffered on the paused sockets until the caller resumes` 回归；还原 `managed.ts` 的 `pause()` 调用后该用例每次必丢帧。
- 相关：[VNC managed-handshake 预算移入 Config](2026-11-17-vnc-handshake-timeout-config.zh.md)。
