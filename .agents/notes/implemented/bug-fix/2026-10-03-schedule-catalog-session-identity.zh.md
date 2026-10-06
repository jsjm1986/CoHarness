# Agent Note: Schedule 目录的 Session 标识与链接 Session 展示

Status: implemented

[English](2026-10-03-schedule-catalog-session-identity.md) | 中文

## 问题

三个缺陷在 Web Schedule 目录通道中同时暴露：

1. `schedule/catalog` 的 Host 记录携带原始 Host `SessionId`，而浏览器侧所有 Session 投影——`sessions.ids`、`sessions.byId`、Workspace 成员关系、归档集合——都以 runtime 限定的 `ClientSessionKey`（`dsh-session:v1:[runtime,sessionId]`）为键。`sessionLinkState()` 拿原始任务 `sessionId` 与键化列表直接比较，把已存在的 Session 误判为 `unavailable`，禁用了链接 Session 按钮。
2. `REMOTE_SESSION_POLICIES` 为 `schedule/*` Remote 声明的是 `['sessionId']` 平铺参数路径，但生成的 Remote 线上形态把这些参数包在 `request` 下（`wire: 'request'`），`mapRemoteSessionIds()` 永远改不到它们。键化的 `sessionId` 原样抵达 Host，所有带键读取（`history`、`delete`、`update`）都以 `schedule_not_found` 失败。
3. `uiWorkspace.openSession` 只通过 layout 插件的当前 Session 订阅把主区域切回会话视图，而该订阅在选中项不变时提前返回。从主面板（Automation tasks 表面）打开已选中的 Session 会让该面板保持激活，链接 Session 的会话视图一直被遮住。

## 决策

在目录边界规范化，而不是在每处比较里兼容。ui-schedule 的目录源把每条 `schedule/catalog` 记录过一遍 `ctx.sessions.keyFor`（池不认识时回退原值），包的其余部分——链接状态、删除、Workspace 成员判断——看到的都是与 Session feed 一致的浏览器 Session 标识。`mapRemoteSessionIds()` 的 schedule 行改为声明 `['request', 'sessionId']`，与 `wire: 'request'` 生成形态对齐，runtime 池由此解析所属 runtime 并在发送前还原原始 Host id。

`openSession` 无条件展示会话。其提交回调在 `ctx.sessions.open(sessionId)` 之后调用 `ctx.layout.selectPanel(null)`，因此从面板表面重选当前 Session 与全新选择一样回到会话视图；该包相应注入 `layout`。侧栏重选保持同一行为——打开总是显示会话视图，侧栏内的普通重选仍然不改动其它状态。

## 备选方案

**在 `sessionLinkState()` 里同时比较两种标识写法。** 否决：这会把裸/键双重处理扩散到每个消费方——归档检查、Workspace 成员判断、删除路径——而池已经拥有唯一受认可的投影口（`keyFor`）。

**让 layout 订阅在选中项不变时也复位面板。** 否决：重选时 `ctx.sessions.list.current` 不变，没有信号可挂复位逻辑，除非扩大选择事件面；展示动作本就属于发起打开的那次操作。

**保持 `openSession` 不动面板、由 Schedule 链接按钮自行清面板。** 否决：每个链接 Session 调用方（今天的 Schedule、未来任何面板表面）都得重复同样的两步，而上游对 open 的契约本来就是"选中 Session 并把它的会话视图作为一次导航动作展示"。

## 影响

`schedule/catalog` 的消费方必须把 `sessionId` 视为浏览器侧已键化；需要原始 Host id 的代码走 `parseClientSessionKey` 或 Remote 层声明的映射。`openSession` 的调用方不再能"打开 Session 但保留主面板"——这正是预期的导航契约；需要被动打开的表面直接使用 `ctx.sessions.open`。

## 测试

[schedule-after.e2e.ts](../../../../apps/web/tests/schedule-after.e2e.ts) 覆盖整条通道：不激活链接 Session 的跨 Session 目录读取与投递记录、链接 Session 打开后回到会话视图（`2 reminders`/`3 reminders`、Session 层级），以及对冷 Session 的目录删除。[apply.client.spec.ts](../../../../packages/client/ui-workspace/tests/apply.client.spec.ts) 断言 `open` 驱动 `layout.selectPanel(null)`。scaffold 的 `extraOverlayPath` 接受补丁列表，场景可以把 Schedule overlay 与浏览器时区断言所需的 `refreshIntervalMs: 0` time-context fixture（[time-context-every-step.patch.yml](../../../../apps/web/tests/fixtures/time-context-every-step.patch.yml)）叠加使用。
