# Agent Note: Envelope-driven stream producers publish on the animation-frame channel

Status: implemented

[English](2026-09-22-stream-producers-publish-on-frame-cadence.md) | 中文

## Problem

React 19 在提交结束时若根仍持有 `pendingLanes & (Sync|InputContinuous|Default)` 便把该提交计为一次嵌套更新；连续 50 次即抛出 #185（maximum update depth）。React 18 下同样的流量不会触顶。

此前客户端会话栈每消费一个 mux 信封都在微任务通道上把对应 notifier 标脏：`SessionManager.handleMuxEnvelope` 为 `session/projection` 与 `session/jobs` 帧标脏列表 notifier，`recordMutation` 为每个 `engaged`/`activity`/`status`/`upsert` 变更（每个流式事件一次）标脏，`ProjectionValueStore.changed` 为每键 face 与任意键通道逐投影帧标脏，`Session.handleMuxEnvelope` 为每个 `session/queue` 帧标脏会话 notifier。微任务冲刷会插入 React 并发渲染切片与提交任务之间，因此持续流式期间（每 token 的 `contextPressure`/`contextBreakdown` 投影加每个内容事件一次的 engaged 变更）每个渲染→提交窗口里都有待处理的通知，每次提交都以仍有工作挂起收尾，嵌套更新计数逐提交递增，长流必然抛出 React #185——在 web verification 流水线中表现为 `chat-scroll-contract`、`trajectory-virtualization`、`chat-long-interactions` 三个 e2e 文件失败。

## Decision

信封驱动的热生产者改用 `markFrameDirty`（每动画帧至多一次发布）代替 `markDirty`（每微任务一次）标脏，即 `Notifier` 本就为流式生产者设计的节奏：

- `ProjectionValueStore.changed`——每键 face 与任意键通道。
- `SessionManager.handleMuxEnvelope`——`session/projection` 与 `session/jobs` 分支。
- `SessionManager.recordMutation`——全部列表变更（`engaged`、`activity`、`status`、`upsert`、`remove`），其在流式期间逐事件到达，是最热的生产者。
- `Session.handleMuxEnvelope`——`session/queue` 分支。

帧合批冲刷在帧边界到达，React 为挂起的存储 lane 排定的渲染在下次发布前干净提交，计数器归零而非累进。在没有 `requestAnimationFrame` 的环境（jsdom 单元测试、Node 消费方）中，`markFrameDirty` 本就回退为微任务调度，浏览器外的发布契约不变。

顺带修复同一响应式契约的两处相邻违规：

- `SessionInputShell.publish`（`ui-conversation/input/facade.ts`）此前对每次会话通知都用新组装的对象调用 `state.set`。现在仅在已发布成员真正变化时才写 store（`sameInputState` 逐成员比较；`claim` 因机器每次读取都会重建，按 token/hint/images 成员比较）。变化之间快照身份稳定正是 uSES 契约。
- `Menu`（`ui-primitives/Menu.tsx`）此前把 `onClose` 放进关闭副作用的依赖表；调用方以内联箭头传入，身份每次渲染都变，副作用随每次渲染重跑并在每次提交中派发 `setOpenSubmenuId`。现在副作用经 ref 读取回调、仅依赖 `open`，与 `Modal` 既有模式一致。

## Alternatives considered

**改为去重已发布的值。** 在标脏前比较传入的投影或队列行需要对任意 wire JSON 做深比较（`preview`/`text` 截断使浅比较对混合内容不可靠），也无法去重本就逐信封前进的值（每 token 的 `contextPressure`）。通知风暴是真实流量；缺陷在其节奏而非存在。

**逐组件守卫可能在提交中 setState 的副作用。** 副作用位点的守卫一次只收敛一个组件，调度风暴依旧——渲染→提交窗口内的每次存储通知都会被计数。计数证据表明驱动是存储发布节奏，而非某个组件。

**把 `markDirty` 本身全局改走帧通道。** 否决：结构性更新（提交回显、待处理交互、`notifyNow` 手势）必须在当前任务内发布；"结构性更新用微任务合批的 `markDirty`，可见的流式分片用累积的 `markFrameDirty`" 这一既有分类已涵盖该区别——修复是把误分类的生产者挪到正确通道，而不是重定义通道。

**把整个客户端迁到原生 `useSyncExternalStore` + transition。** 绑定的 selector hook 无法为存储通知选择调度 lane；React 自己把 uSES 重渲染标在 SyncLane。绑定侧的任何改动都消不掉计数器所量的提交末尾挂起工作。

## Consequences

- 三个此前失败的 e2e 文件在 React 19 下全部通过（`chat-scroll-contract` 5/5、`trajectory-virtualization` 2/2、`chat-long-interactions` 1/1）；全部客户端单元测试不变通过，因为 jsdom 没有 `requestAnimationFrame`，帧通道回退为微任务。
- 投影、列表变更、jobs、queue 发布在流式期间每帧至多一次；标题、权限翻转、队列基线多承担一帧（约 16ms）延迟，这正是 `markFrameDirty` 对会话内容已有的取舍。
- `SessionInputShell` 仅在成员移动时重新发布 `InputState`，未触及下游的会话通知不再重渲染 composer 树。
- `Menu` 的关闭副作用只在 `open` 边沿运行；所有调用方（不止 `PermissionSelect`）继承修复。
- 新覆盖钉住节奏契约：`session.client.spec.ts` 的 `session/queue` 帧发布、`projection-store.client.spec.ts` 的每键/任意键帧合并、`skeleton.client.spec.tsx` 的 store 写入去重。
