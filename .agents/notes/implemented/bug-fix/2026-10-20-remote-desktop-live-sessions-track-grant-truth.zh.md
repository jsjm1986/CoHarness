# Agent Note: Remote-desktop live sessions track grant truth through expiry, failure, and mutation

Status: implemented

[English](2026-10-20-remote-desktop-live-sessions-track-grant-truth.md) | 中文

## Problem

VNC Provider 的 `live` 会话表曾以三条互不相关的路径偏离授权事实。过期未消费的 attach token 只删除 `pending` 条目，会话却永久留在 `live` 中——`status().attachments` 计入幽灵会话，该表无界增长。已消费 token 在泵启动前失败（端点缺失、拨号不可达、录制器无法打开）同样留下幽灵会话，外加一条仍连接的 upstream socket，因为只有 `socket.destroy()` 执行。而存活会话还会活过授权它的授权集：`revoke` 与 `setLevel` 降权提交了授权变更，已打开的流——连同其 control 级输入通路——却一直运行到客户端自行断开。此外 `listGrants` 回答的是“存在哪些行”而非“调用者现在可挂接哪些目标”，最终用户的引导入口因此可能列出绑定其他会话或其他 principal 的目标。

## Decision

会话记账现在共用一条提交路径。`attach` 为每个 token 装上定时器；未消费的 token 过期进入 `finishDetach`，移除 `live` 条目、记录 `detach` 并发出 `remote-desktop/attached`。token 消费后的每个 `serveStream` 失败——端点缺失、拨号失败、录制器打开失败、条目过期——都销毁两侧 socket 并完成同一条 detach，`live` 中不再存在没有流的会话。`revoke` 与 `setLevel` 调用 `enforceLiveSessions`：按已提交的存储对每个存活会话重跑 `matchingGrants`，已解析级别不再被授权的会话被拆除；仍有授权支撑的流保持打开。`listGrants` 新增 `attachable` 与调用者绑定的 `sessionId`，经 `resolve` 所用的同一个 `matchingGrants` 谓词过滤并要求目标已配置端点；浏览器控制器把 `sessionId` 绑定到被寻址的 agent，引导入口传 `attachable: true`，列出的目标恰好是 attach 会授权的目标。标签页主体启用了此前闲置的 `disconnect`/`reconnect` 文案：断开即关闭 RFB socket（服务端随之拆除），重连按已记录的确认重走 status → attach 换取新 token。

## Alternatives considered

**让存活会话保持到客户端自行断开，即使授权被撤销。** 否决：撤销是管理员动作，必须生效；control 级流在自己的授权被撤后继续存活，等于越过授权边界静默放宽访问。

**在 `attach` 内惰性清扫过期 pending 条目。** 原 `sweepPending` 只在下一次 attach 时运行，没有新 attach 的部署会无限期持有幽灵会话。按 token 的定时器让过期自我驱动；清扫被移除而非保留为第二个时钟。

**在控制器或引导入口里过滤可挂接行。** 否决：会话作用域匹配必须与 `resolve` 一致，在 `matchingGrants` 之外复制该逻辑会让列表与强制谓词漂移。

**暴露 `detach` Remote 方法而非关闭 socket。** 延后：流关闭已能到达 `finishDetach`，显式的管理员强制 detach 方法仍是后续工作，不作为面向用户的调用。

## Consequences

`status().attachments` 现在只计真实会话，`live` 的上界变为 token TTL 加流寿命，管理员授权变更在同一调用内对已打开的流生效。审计轨迹记录被强制的 detach，被撤销的会话同时呈现 `revoke` 与其 `detach`。泵前失败的会话同样写入 `detach`，attach/detach 成对保持平衡。代价是每次授权变更多一次授权集扫描——以存活会话数为界，而该数本身现在已有界。`tests/service.spec.ts` 固定了过期 detach、撤销与降权 detach、仍有授权存活的情形、录制器失败拆除与可挂接列表；`tests/ws-duplex.spec.ts` 覆盖把 detach 带到线上的流适配器。
