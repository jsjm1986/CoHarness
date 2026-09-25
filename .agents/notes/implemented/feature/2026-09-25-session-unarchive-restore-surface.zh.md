# Agent Note: Session 取消归档——线协议逆操作与「已归档会话」设置页

Status: implemented

[English](2026-09-25-session-unarchive-restore-surface.md) | 中文

## 问题

注册表级全局归档集合此前只有写入路径（`workspace.archiveSession` 与客户端对象层的 `archiveSession`），没有面向用户的逆操作：已归档会话只能一直隐藏，直到组织管理员通过 Gateway 归档通道恢复。上游对齐新增了 `workspace.unarchiveSession` 以及一个设置页作为自助恢复入口。

## 决策

**取消归档复用归档侧的线协议与客户端语义，而非另起一套并行协议。**

- RPC：`workspace.unarchiveSession({sessionId}) → {archivedSessionIds, archiveRevision?}` 与归档签名对称——同样的全快照应答、同样的 `host/archived-sessions-changed` 帧、同样的可见性过滤。它在 handler 层幂等：`workspaceRegistry.restoreSession` 对不在集合中的 id 本就静默返回，因此与其他界面的竞态落败时以当前快照应答而非报错。
- Registry：`restoreSession` 在移除时与 `archiveSession` 在追加时一样推进 `archiveRevision`，因此客户端的带版本安装路径会整体替换集合——合并路径只留给无版本的旧式载体，此时并集是安全的"只增"默认。若取消归档的回声不带版本号，其缩小的集合会被合并吞掉，这正是 fixture 现在也跟踪 `archiveRevision`（与真实 host 一致）的原因。
- Client：`IWorkspaces.unarchiveSession` 委托给 manager 安装回声集合；不需要清理选中态，因为已归档会话本就不可能是当前会话。
- UI：新增 `ui-settings-unarchive-sessions` 插件贡献一个 `settings.section`（id `archived-sessions`，order 25，排在最末），把归档集合与已加载的会话摘要连接后按归档时间倒序展示，带搜索框与每行一个"取消归档"按钮。摘要始终未加载的成员不渲染行；全部不可恢复的集合报告为"不可恢复"而非"空"。插件直接注入 `workspaces` 服务——恢复不涉及导航耦合，因此上游的 `ctx.uiWorkspace` 间接层在本地没有对应物。
- `relativeTime` 从 `ui-workspace` 的树派生层上移到 `ui-primitives`，让侧栏行与设置页共用同一套时间分桶；文案仍保留在各插件自己的词典中。

## 已考虑的其他方案

**新增逐 id 的增量协议。** 与归档侧同样的理由否决：集合很小，且每个载体本就应答完整快照。

**侧栏行菜单取消归档。** 否决：已归档行按定义从树中隐藏，没有可挂载操作的行；设置页是唯一的恢复面，与上游一致。

## 影响

个人范围用户现在可以自助恢复；Gateway Admin 归档通道保留其独立的组织级角色（跨运行时查看、回收窗口、清除）。删除会话记录仍是设置页不提供的独立能力。恢复与归档在同一 `archiveRevision` 计数器上推进，因此所有版本序保证不变。[会话归档全局集合 note](2026-07-31-session-archive-global-set.zh.md) 拥有集合的存储与合并语义；[Admin 归档通道 note](2026-08-25-admin-archive-channel.zh.md) 拥有组织级索引。
