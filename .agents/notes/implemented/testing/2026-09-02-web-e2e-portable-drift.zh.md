# Agent Note：Web e2e 场景跟随已发布的 Chat，而非上游录制

状态：已实现

[English](2026-09-02-web-e2e-portable-drift.md) | 中文

## 问题

[可移植 runner 默认值](../process/2026-09-02-portable-ci-runner-defaults.zh.md)取代从未配置过的企业 runner 池之后，`web browser snapshot` 门禁第一次在 GitHub 托管 runner 上真正执行，90 个文件里 26 个失败。在一台 10 核机器上以 replay 模式本地复跑，失败的仍是同样 26 个文件，说明 runner 速度不是原因：这些场景与 golden 描述的仍是 alpha.1 对齐时从上游导入的那个 Chat，而已发布的 Chat 早已前进。三个根因解释了绝大部分失败，另有一个文件暴露出一个已单独修复的 Host 缺陷，而在当前基线上重跑修好的 lane 又暴露出一个在此修复的 Chat 缺陷。

- **种子历史没有时间。** 对齐时接收了上游的投影式 fixture（无 `seq`/`time` 字段，chunk 连续段打包成一行），却没接收 `seedSession` 里按事件顺序物化时间的那一步。所有种子事件都停在 epoch 0，于是日期渲染成 `1970-1-1`，`StatsLine` 派生出的时长全为 0，33 个 golden 期望的 `LLM`/`Tool call`/`tok/s` 段被隐藏。
- **已结束的 turn 折叠其过程。** `TurnProcessNodeView` 现在把一个已完成 turn 的工具调用和中间消息收进一个 `[data-turn-process]` disclosure，只在流式进行中默认展开。那些定位历史工具行（`[data-sample="bash"]`、`[data-tool="skill"]`、`[data-workflow-run]`）的场景，在已挂载但被折叠的行上超时。
- **阅读位置接近顶部时自动加载更早历史。** `ChatView.maybeAutoLoadOlder` 在读者进入距顶部 240px 内时自动请求上一页（每个 head 一次），`Load earlier` 控件只保留给停在阈值之外的读者。先滚到顶再等控件的场景，发现页面已经加载完、控件消失、读者被重新锚定在顶部以下。
- **打开大型冷会话失败。** `historySourceFor` 为 detached 会话逐页读取持久化数据，并拒绝页间 revision 变化。浏览器打开会话同时会 attach 它（`ensureSession` → `agents.resume`），resume 追加的生命周期事件让 JSONL 的 revision 在逐页读取途中变化。因此需要多页的历史打开即报 `history storage is temporarily unavailable`，而单页历史永远碰不到这个竞态。Host 侧修复是独立改动（[历史读取在并发 resume 下存活](../bug-fix/2026-09-03-history-read-survives-concurrent-resume.zh.md)）；本记录只覆盖依赖它的场景侧。
- **采样间隔内切换 tab 或会话会丢掉最新的阅读位置。** `ChatView` 对阅读器几何的采样每 500 ms 至多一次并附带一次尾随采样（[有界实时窗口](../bug-fix/2026-09-03-bounded-live-window-and-incremental-reconnect.zh.md)）；其卸载清理只清掉挂起的尾随定时器而不执行它，于是在最后一次滚动后 500 ms 内切换就什么都没保存，回来时恢复到那次滚动之前的位置。`chat-scroll-contract` 看到锚点落在离开处 794px 之外。
- **队列场景在提交途中捕获了 composer。** 队列 dock 在会话流带来排队行的那一刻就列出它，而 composer 在提交往返落定前一直保留草稿与禁用的控件。只等 `2 queued messages` 头部，在往返变慢时捕获到的就是 `Message the agent: Layout queue second` 和禁用的 `Send message`。

其余是产品层面合理的变化：权限标签本地化（`Read Only` → `仅可查看`、`Workspace Write` → `工作区内修改`）、侧栏的 `New session in workspace` 操作与 `Ungrouped` 分组的移除、hero 与 header 布局、`session.list` 返回 `items` 且不列出草稿会话、新的默认模型（`deepseek-v4-flash-vision-exp`）与重命名的容量字段、Web surface 系统提示文案、以及基于 `records` 的历史线上格式。

## 决策

每个根因只在拥有它的那一层修一次，只重录那些 diff 确为有意产品变化的 golden。

- `seedSession` 按上游方式物化事件时间：`timeAnchor + index`，锚点取 fixture header 的 `createdAt`，若归一化把它置零则取种子创建时间。`rewriteSeedEvents(text, edit)` 让两个需要裁剪或续写录制的场景在解码后的事件上编辑，而不是改原始行——投影式 fixture 已不支持后者。
- `expandTurnProcesses(page)` / `collapseTurnProcesses(page)` 用纯 Playwright 等待展开与折回所有 turn-process disclosure，因此也能在 `beforeAll` 中使用。场景先展开再断言历史行；golden 捕获默认视图的场景在捕获前折回。live-tool 滚动场景只展开自己那个 turn 的 disclosure，因为展开所有已加载 turn 会把整段 transcript 重排、离开正在测量的尾部。
- 分页 helper 兼容两种到达路径：`loadEarlierWithAnchor` 以短步向顶部滚动、在第一次 prepend 到达时停下，只在到顶仍无请求时点击 `Load earlier`，整段日志加载完后返回 `false`；`scrollToHistoryStart` 不再断言稳定的 offset，因为锚定式 prepend 会合理地移动它。
- 断言投影的种子场景（`hasProjections`、fork 标题的 `(1)` 后缀）在 seed 后调用一次 `sessionProjectionCache.coldSnapshot(id)`。所有由 Host 写出的会话都带有 projection-cache 行；种子日志没有，而 `session.list` 对冷会话只从该缓存取值。
- 共享归一化新增 `\b\d[\d,]*(?:\.\d+)? ms\b` → `{{duration}}`（trajectory tooltip 中的 wall time）以及可选日期前缀折叠 `(?:\d{1,2}/\d{1,2} )?{{clock}}` → `{{date}} {{clock}}`，golden 因此既不依赖 runner 时区也不依赖种子的墙钟。
- Trajectory 底部跟随预算改为相对于该 turn 追加的行数（`scrollTo` 调用 ≤ 追加行数 / 4，且至少追加 20 行），而非上游常数 5：这里一次流式 turn 追加 85 个 chunk 与 turn 的生命周期事件，不变量是"绝不按 chunk 滚动"，而不是某个行数。
- `ChatView` 的卸载清理改在 `useLayoutEffect` 中运行，并在那里执行挂起的尾随采样：布局清理先于 React 解绑子 ref 与移除节点执行，此时滚动口仍有布局，而被动清理无法保证这一点。
- 队列场景在捕获前等待 composer 草稿清空，与 `live-interactions` 已有做法一致；golden 描述的是带 steer 提示的已落定 composer，即读者实际看到的状态。
- 13 个 golden 在逐一对照上述产品变化审阅 diff 后重录；没有 golden 丢失 transcript 内容。

## 备选方案

**在测试中禁用自动加载以保留固定的 `Load earlier` 分页模型。** 否决：自动加载才是读者实际得到的行为；钉住手动控件的场景会通过，而已发布的路径不受测试。

**跳过折叠行场景，或只断言折叠摘要。** 否决：disclosure 背后的行仍承载契约（身份、跨滚动周期的 disclosure 状态、焦点归属）；先展开再断言让该契约继续受测。

**不分类地重录全部 26 个 golden。** 否决：26 个文件里 23 个败在行为或时序而非 golden 文本；重录会把 epoch 日期和被隐藏的统计固化进基线。

## 影响

该 lane 在可移植 runner 上转绿，且未改动其 worker 数或并发度。种子 fixture 暴露出的两个行为作为产品信号保留、未改测试：从未写过缓存行的冷会话在打开并 attach 后，列表行标题不会收敛，直到某个投影变化或客户端重连（Host 只在变化时推送 `session/projection` 帧，客户端只在连接时重新列表）；种子或重新加载的历史不显示 `TTFT`/`tok/s`，因为 `assistant/chunk` 事件不进入 conversation tier。两者都在受影响的场景中留有说明，待产品决策。
