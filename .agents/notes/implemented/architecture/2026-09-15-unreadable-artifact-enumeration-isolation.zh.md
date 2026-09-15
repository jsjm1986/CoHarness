# Agent Note：不可读会话工件在枚举中被隔离

状态：已实现

[English](2026-09-15-unreadable-artifact-enumeration-isolation.md) | 中文

## 问题

单个损坏的会话工件不应让其他所有会话的列表失败，但枚举路径原本逐项失败即整体失败：`listSnapshots` 无容错地读取每个 draft 的完整事件体，`listArtifacts` 让一个无法解码的头部帧中止整次扫描，`archiveSyncBatches` 让一个不可读的已归档会话拒绝整份同步负载。存储中只要有一个撕裂的 draft，`session.list` 就返回 HTTP 500，工作台目录一直为空，任何会话都无法打开。

`syncRuntimeSnapshot` 在上一层有同样的缺陷：`assertRuntimeSessionOwnership` 拒绝任何在 `conversation_sessions` 中没有行的上报 id，因此会话只存在于本地存储的 runtime 永远无法同步。归档通道的契约明确要求支持个人转录不在 PostgreSQL 中的记录，所以缺行是正常状态，并非外部归属的证据。

## 决策

枚举隔离不可读项并通过 `ctx.logger.warn` 报告；标识不符、编码错配与重复 id 违例仍然抛出，对该工件的定向读取也仍然报告真实错误。不可读的 draft 被省略，因为 draft 只有证明携带内容才配拥有列表行；持久会话保留其头部行，改为在打开时失败。

归档同步适用同一规则：日志不可读的已归档会话只贡献其裸 id——已存储的记录保留——而不是让整份负载失败。`assertRuntimeSessionOwnership` 只对已存在的 `conversation_sessions` 行强制调用方的作用域，并只在存在已存 root 时校验谱系 root。

## 考虑过的替代方案

**对每个异常都失败关闭。** 否决：逐项故障被放大成整个面的不可用，且持久会话会因与己无关的损坏而失去列表。

**在每个消费者里逐项容错。** 否决：规则属于枚举操作本身；门面与调用方无法可靠地重建是哪一项失败以及为何失败。

## 影响

撕裂或截断的工件降级为一次告警加省略，而不是 500，归档投影同理。属于其他所有者或作用域的会话 id、或与已存行矛盾的谱系 root，仍然会拒绝整份快照。损坏的工件保留在磁盘上供检查；恢复是单独的显式操作。

## 验证

`session-persistence-jsonl` 的用例覆盖损坏的 draft 事件体、过短或畸形的头部帧、超限头部各自不影响列表其余部分。`archive-gateway` 覆盖不可读已归档会话以裸 id 与健康负载并存。`conversation-archive-service` 覆盖外部所有的已存会话拒绝快照、以及无已存行的 runtime 本地 id 正常同步。
