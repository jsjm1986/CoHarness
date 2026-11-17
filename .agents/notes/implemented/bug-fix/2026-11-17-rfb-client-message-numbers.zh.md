# Agent Note:RfbClientFilter 按 RFC 6143 类型号解析客户端消息

状态:implemented

[English](2026-11-17-rfb-client-message-numbers.md) | 中文

## 问题

`RfbClientFilter` 把 RFB 客户端→服务端消息类型整体错记了一位:`FramebufferUpdateRequest` 记为 `2`(10 字节)、`KeyEvent` 记为 `3`(8 字节)、`PointerEvent` 记为 `4`(6 字节)、`SetEncodings` 记为 `1`、`ClientCutText` 记为 `5`,且 `VIEW_ALLOWED = {0, 1, 2}`。RFC 6143 中这些消息的类型号是 `3`、`4`、`5`、`2`、`6`,允许集合应为 `{0, 2, 3}`。

view 级浏览器在同一个 chunk 里写入 `KEY_EVENT ‖ FB_UPDATE_REQUEST` 时,错误的表会这样消费:`KeyEvent`(type 4)按 6 字节的 `PointerEvent` 截帧并丢弃;剩余缓冲以 `00 61 ‖ 03 …` 开头——被当作需要 20 字节的 type `0`(`SetPixelFormat`)而缓冲里只有 12 字节——于是过滤器返回空并把真正的请求永久扣住。上游永远收不到 framebuffer 请求,splice 断言在 coverage、seatbelt 与 Windows lane 上超时。

这个失败看起来像投递竞态,因为本地运行用的是工作区里已修正的 `rfb.ts`,而 CI 跑的是已提交的错误表。emit 时的监听器快照与 `filter.push` 探针排除了监听顺序问题,并直接显示 `push` 对 18 字节输入返回空且 `dropped=1`。

## 决定

把 `rfb.ts` 中的常量改回 RFC 6143 编号:`FRAME_FIXED = {0:20, 3:10, 4:8, 5:6}`、变长 `SetEncodings` 为 type `2`、`ClientCutText` 为 type `6`、`VIEW_ALLOWED = {0, 2, 3}`。`rfb.spec.ts` 把 fixture 字节改成真实线上的类型号,并新增回归:把每种帧拼接后在每个字节边界切分推入,断言允许子集原样输出且 view 禁用的帧计入 dropped。

## 后果

- 丢帧不再导致流错位:`KeyEvent` 消费完整的 8 字节,随后的 `FramebufferUpdateRequest` 正确成帧并转发。
- 错误表此前还会拒绝合法的 view 级 `SetEncodings`(type 2)并按错长度消费 `PointerEvent`(type 5),现在都与规范一致。
- 该问题只在覆盖率插桩下暴露,是因为工作区中修正的 `rfb.ts` 从未提交;新的字节切分规格把该表固定下来,不受文件漂移影响。

## 备选方案

- 按泵/监听器时序处理——被插桩证据否决:`upstreamChunk` 持有完整的 18 字节 chunk 而 `upstream.write` 从未被调用,丢失点隔离在 `push` 内部。
- 缓冲残留直到帧类型可校验——否决:只有类型表正确时协议才自定界;错误的表无法发现自身错位。

## 验证

- `packages/remote-desktop/remote-desktop-vnc` 套件——`rfb.spec.ts` 与 `managed-handshake.spec.ts` 本地 20/20;对已提交的 `rfb.ts`,splice 测试确定性复现 CI 签名(上游为空、泵 pending)。
- 相关:[VNC managed splice pauses both sockets across the reader-to-pump handoff](2026-11-17-vnc-managed-splice-flowing-gap.zh.md)。
