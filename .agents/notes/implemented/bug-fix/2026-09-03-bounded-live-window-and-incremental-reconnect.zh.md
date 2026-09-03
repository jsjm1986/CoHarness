# Agent Note: 限定活动历史窗口并把重连追赶改为增量

Status: implemented

[English](2026-09-03-bounded-live-window-and-incremental-reconnect.md) | 中文

## Problem

Web 客户端在长对话上感觉很慢，且会话运行越久越慢。五个彼此独立的机制相乘：[活动历史保持](2026-08-24-live-conversation-history-retention.zh.md)的补齐在舞台会话一开始运行就拉取每一页更早的 conversation 页面，于是驻留窗口从一个 50 条消息的尾页膨胀为整段日志（最多 64 页），此后每次流式发布都要按这个节点数重建与协调；`TrajectorySnapshotBuilder.apply()` 在每次发布时从零重建全部账本数组与 Map，Trajectory 标签页隐藏时也一样，并发布全新身份，使 `TrajectoryView` 中的每个布局 memo 失效；`ChatView` 在每个 scroll 事件上用四次 `elementsFromPoint` 探测命中流，包括它自己的跟随写入在每次发布时触发的那个 scroll 事件；一次连接丢失会重置每个已打开的窗口（`events = []`、`openState = 'cold'`），并对运行中的舞台会话重新开始完整补齐，而 Gateway 部署在签名 principal 到期时每 30 秒触发一次；每个流帧在 Host 上序列化两次（字节预算一次、载体一次），在浏览器里又只为了数字节再拷贝一次。

## Decision

活动补齐在尾页之后最多保留 `LIVE_HISTORY_RETAINED_PAGES = 3` 页更早页面，由 `Session.liveHistoryPages` 计数并随窗口重置（`leaveStage`、`installWindow`）。因此运行中的舞台会话最多驻留 4 × `PAGE_MESSAGES` 条消息；达到上限后 `beginLiveHistory()` 成为空操作，之后的 prompt 与 running 边沿不再扩展窗口。走到日志头部的补齐仍进入 `historyWindowMode: 'live'`；被上限截断的补齐回到 `'tail'` 并保持 `hasMore: true`，所以更早页面控件与近顶自动分页在轮次结束后恢复。`MAX_HISTORY_EXPANSION_PAGES` 仍是阅读器跳转（`loadHistoryUntil`）与 detail 补全的上限。

`Session.resync()` 保留已打开的窗口。持久事件从不改变，所以重连只清除待处理交互等待与 subscribed 基线，然后执行缺口修复：读一次尾页合并进驻留窗口，且不递增 open generation，因为在途的分页请求仍是有效历史。只有仍在加载或处于错误状态的窗口才会重置并重新打开。`repairGap()` 可等待且可合并：修复在途时发出的请求会让正在运行的修复再读一次尾页，而不是被 stitching 守卫丢弃。`mergeTail()` 在所有遗漏事件都位于尾部之后时原地追加（重连的常态，节点身份保持），在页面同时覆盖更早前缀时按序合并，仅当尾页的逻辑基线不再与窗口相接——流断开时间超过一页所覆盖的范围——时才通过 `installWindow()` 替换窗口；运行中的舞台会话随后重新开始有界补齐。越过已打开窗口尾部的 `session/subscribed` 基线触发同一修复，因此流断开期间转为空闲的会话无需等待下一个实时事件即可追上。

`TrajectorySnapshotBuilder` 区分「只移动了某个 Assistant 流式 partial 的发布」（settled 节点相同、request 浅相等）与其他一切变化：前者只替换上一个快照的 `partial` 字段；后者重建账本，但对内容浅相等的每一行复用上一个元素（按 `seq` 或 `startSeq` 匹配），没有任何行变化时复用上一个数组，条目完全相同时复用上一个 `eventLocations` 与 `callSchemas` Map。

`ChatView` 对阅读器几何（决定活动轮次的可见行、待处理的 prepend 锚点、保存的滚动位置）的采样每 `SCROLL_SAMPLE_INTERVAL_MS = 500` 至多一次并附带一次尾随采样，在 prepend 待处理期间立即采样以便到达的页面保住阅读器最新的行，且从不为跟随写入做命中测试：当 scroll 事件是账本自己在钉住状态下的程序化写入时，由尾节点决定活动轮次。

`dsh-host-apiproxy/api` 中的 `serverRequestJson(frame)` 用 `WeakMap` 为每个帧对象只序列化一次线上 `ServerRequest` 信封；`FrameQueue` 据此计字节，两个载体（`WebSocketDownlinks.send`、SSE 处理器）写出的都是这份记忆化文本。浏览器下行按文本帧的 UTF-16 长度计预算——它是 Host 已接纳的 UTF-8 字节数的下界——而不再重新编码。`ui-conversation` 中的 `projectAssistant()` 按（state 对象，start Location）对记忆化一份投影，让同一次 flush 的 step 作用域 Location 数据与视图节点共用它。

## Alternatives considered

**保留完整活动窗口并给 Chat 列表做虚拟化。** 虚拟化限定的是 DOM，而不是每次发布时对数千节点的 assembler、快照与协调工作，并且它对一个分页锚点、跟随滚动与轮次导航都依赖真实行几何的视图来说是一次大改动。限定窗口从源头消除了乘数；虚拟化仍是一项独立的、可选的改进。

**运行期间只隐藏更早页面控件而不保留任何页面。** 2026-08-24 的记录因活动文本记录仍不完整而否决了它。保留三页让轮次期间的近期记录可读，同时限定成本；控件只为超出上限的历史重新出现。

**重连时重置窗口但跳过重新补齐。** 重置仍会丢弃阅读器位置、重建每个 Context、在每次 30 秒一次的 Gateway 重连中重新挂载每一行。合并一次尾页读取只花一个请求，且不触碰未变化的行。

**长时间断连时逐页桥接而不是替换窗口。** 从新尾页向后走到过时窗口，恰恰重演了本记录要消除的无界工作，却只为一个罕见场景。替换窗口付出的是一次舞台重进的成本，且只在断连超过一页覆盖范围时发生。

**像 `ChatSnapshotBuilder` 那样用逐行索引让 `TrajectorySnapshotBuilder` 完全增量化。** 账本的后处理（压缩中断、轮次错误、header 继承）读取整个有序列表，所以结构变化仍需要重建。在重建后复用内容相等的行与数组，就能给视图所需的身份稳定性，而不必复制排序逻辑。

**延长 Gateway principal TTL 或不再在到期时中止流。** 两者都改变 Gateway 拥有的安全模型；部署仍可自行提高 `HGW_PRINCIPAL_ASSERTION_TTL_MS`。本记录让每次重连无论起因都变得廉价。

## Consequences

运行中的长会话每次发布最多为四页节点付费而不是整段日志，一次重连的成本是一次尾页读取加遗漏的行，而不是窗口重建加重新补齐。Trajectory 的 memo 在一次流式过程中得以保留，Chat 的滚动处理每秒最多强制两次布局。大型工具结果在 Host 上只序列化一次，在浏览器里少拷贝一次。

比保留页面更早的历史在轮次结束后只需一次更早页面请求，轮次期间不显示；轮次中滚动到保留窗口头部的阅读器在轮次结束前看不到分页控件，与之前一致。断连超过一页后的重连会替换窗口并丢弃阅读器位置，这正是此前每次重连的行为。浏览器字节预算会接纳 UTF-8 大小超过其 UTF-16 长度的帧；1024 项上限与 Host 自己的 8 MiB 预算保持不变。

Runtime 测试覆盖有界补齐及其不续拉规则、resync 保留已打开窗口、合并的修复、替换回退、append-only 与合并路径，以及 subscribed 基线修复。构建器测试覆盖仅 partial 的发布与结构重建中的行复用。ChatView 测试覆盖采样节奏与跟随写入的豁免。`serverRequestJson` 测试覆盖记忆化与重新抛出。
