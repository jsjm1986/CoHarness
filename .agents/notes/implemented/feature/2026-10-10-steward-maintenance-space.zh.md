# Agent Note: 维护中枢空间是携带常驻运行时的保留项目

Status: implemented

[English](2026-10-10-steward-maintenance-space.md) | 中文

## 问题

维护一个部署——检查数据库、调整管理端设置、准备代码改动——没有产品内通道；在普通项目运行时里做这些事会把维护耦合到工作区自身的生命周期：装一个插件就会重启正在干活的那台运行时。需要的是一个对话驱动的维护面，在普通运行时空闲、重启或出故障时仍然在线。

## 决定

保留的 steward 空间复用现有项目空间机制，而不是新增第三种运行时目标类别。`projects.kind`（`standard`/`steward`，迁移 051）为每个组织标记一个保留项目；准入、生命周期、工具面和审计叠加其上。

- **资格是独立通道。** `steward_access_policies`（按用户、启用标记、版本栅栏的管理写入）单独决定 steward 准入：具备资格的活跃用户以 `rw` 进入，没有该行的组织管理员同样被拒，成员/邀请行按契约保持为空——对 steward 行的项目变更直接拒绝。资格替换成员资格而非叠加，因为空成员表会让非管理员永远够不到这条通道。
- **运行时常驻且不能重启自己。** 启动播种项目并调用一次 `ensureRunning`；steward 目标的 systemd 单元渲染 `Restart=always`，空闲回收排除 steward 项目，管理员显式停止则保持停止直到下次启动或显式拉起。插件状态与插件管理写入拒绝 steward owner，因此固定组装（`dsh-steward-tools` 经 profile 补丁）永远不可能从空间内部改变。
- **身份来自数据库而非请求。** steward 特权——特权单元渲染、回收豁免、查询端点准入——一律读取经实例仓储解析的 `projects.kind`，调用方传入的标记无法把普通项目提升为 steward。
- **客户端表面携带警告族身份。** 空间切换器用警告色（琥珀）渲染「维护」徽标、行内状态点与当前触发器描边；`conversation.input.dock` 内的 `StewardDock` 卡片在空间中陈述审计与写批准契约，几何与 GoalBar/Todo/Queue 的 composer 栈 dock 卡一致（内缩宽度、细描边、`radius-lg`）；范围激活时录入框占位文案也换成 steward 提示。scope 标记另经 `projectUiPolicy`（协作插件本来就在发布的运行时 policy）下发，`ui-conversation` 读 `steward` 不必引入协作插件。所有标记一律读取账户上下文里的 `kind`/`steward` 字段——绝不看显示名——普通项目不受影响。
- **SQL 访问是受审计通道，不是进数据库的 shell。** `POST /internal/runtime/steward/query` 要求 steward 绑定 generation 的运行时令牌，在服务端重新分类语句，执行语句/行数/结果/超时限额，并把包括拒绝在内的每次尝试写入 `steward_query_log`。关键字分类只选择通道：判为只读的语句在 `READ ONLY` 事务内执行，因此 `EXPLAIN ANALYZE` 与可写 CTE 失败关闭而不是夹带写入。写语句另外需要同一 steward 项目会话内、仍具资格的应答者授予的近期 `allowed-once` 交互批准；审批 id 上的 advisory 锁串行化写入方，使一次批准恰好放行一次已提交的写入，写入在同时写入审计行的事务内执行。

## 考虑过但未采用

**`kind='maintenance'` 运行时目标。** 放弃：它要把目标判别联合扩展贯穿实例、插件状态、会话、审计、代理和会话键编码——用 schema 与 wire 扩张去重新推导项目空间已经提供的东西（独立 cwd、组装、会话、治理）。

**在 `admin-ui` 里做对话。** 放弃：管理端 SPA 没有会话与流式栈；steward 空间以零客户端运行时成本复用现有会话面。

**成员资格叠加在资格之下。** 放弃：steward 成员表按设计为空，`member OR admin` 会拒绝每个有资格的普通用户，使该通道成为死授权。

## 影响

该空间无法在对话之外操作自身：组装被锁死，worktree 改动仍走普通 PR 与发版流水线；v1 刻意不带通用运行时调用代理与发版激活自动化——两者都在 Gateway README 中记录为延后项。本地 launcher 下的常驻仅覆盖 gateway 进程存活期，只有 systemd 提供监督重启。仅 PostgreSQL：SQLite 目录不建模 `kind`，`HGW_STEWARD=on` 只在实现了 `ensureSteward` 的后端上有意义。
