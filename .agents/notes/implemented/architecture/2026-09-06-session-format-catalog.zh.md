# Agent Note：Session 迁移使用单一相邻 catalog

状态：已实现

[English](2026-09-06-session-format-catalog.md) | 中文

## 问题

Session provider 需要在读取事件体前对存储 header 分类，也需要一份覆盖每个已发布代次的确定性迁移计划。如果 JSONL、Gateway 和 SQLite 各自复制版本判断，不同 provider 就可能出现一个接受而另一个拒绝同一代次的情况；若再存在第二套准入实现，发布版读取器拒绝的畸形输入还可能从某条路径漏过。

## 决策

`@deepseek-ai/dsh-session-format` 拥有 provider 无关的迁移机制；`@deepseek-ai/dsh-session-format-catalog` 编译完整的发布链 v0 → v1 → v2 → v3 → v4 → v5，是唯一的准入与迁移规则来源。新代次在读取事件体前拒绝；旧代次必须经过每条声明的边。输入会被快照并冻结，catalog 不会写入存储。

两个 catalog 共享同一条链。`sessionFormatCatalog` 服务 JSONL 读取方：解码发布版物理行、应用发布版 codec 的准入、还原当前 artifact。`sessionLogicalFormatCatalog` 服务存储已解码 header 与事件行的后端（SQLite、Gateway/PostgreSQL、脱离对象的协调器读取）：把存储元数据投影到发布版 header 要求上（`seedLength` 即 `isSeeded` 的存储拼写；未知键拒绝），准入逻辑事件信封，并把事件流经同一套发布版边与同一套当前 artifact 校验。v2 边路由到 `coharnessV2ToV3Dialect`——声明的 CoHarness 数据库方言，只负责排序与归一化（首个 `step/start` 前的 turn 级 surface 载体、请求头携带的系统提示提升为生成的 `system/message` 节点、在继承截断处存在或合成的 `session/end-seed` 标记），同时复用发布版 stage 的载荷准入、引用重映射、规范化与退役词汇改名。

v3 之前的边会归一化每个代次可能携带的历史事件词汇（旧版消息载荷、`start`/`end` replace 键），同时推进代次标记。`Session` 构造本身只接受当前版本 header——迁移归存储边界负责，与上游一致。JSONL 会原子发布当前 generation，SQLite 在一次写事务中替换事件行与元数据行；Gateway 的迁移 wire 只携带目标 header，因此它不声明 body 迁移支持，coordinator 直接跳过发布，而不是让服务端在未迁移的 body 上落一个新版本 header。provider 备份仍由 adapter 负责，本纯包不会隐藏这些行为。

## 考虑过的替代方案

**让每个 provider 自己维护版本链。** 拒绝，因为独立链会导致拒绝和迁移行为分叉。

**在 header 列表时重写 artifact。** 拒绝，因为只读 header 操作必须保持无副作用，且在事件体验证前不能生成新代次。

**原样导入上游 Session 包。** 拒绝，因为上游发布版 header 和事件类型不是 CoHarness 的持久化约定；本包只保留可复用的规划机制，adapter 继续掌握本地语义。

**为数据库行保留独立的宽松 catalog。** 拒绝：第二套规则源会偏离发布版行为——放行物理路径拒绝的夹具、跳过发布版边应用的退役词汇改名。逻辑 catalog 改为把存储方言投影到同一套发布版 stage 上。

## 结果

Provider 实现拥有统一的迁移规划器和稳定诊断类别；畸形逻辑输入与物理路径同样被拒绝。catalog 本身不写入存储；JSONL 和 SQLite 负责各自的 provider 发布。Gateway 客户端会发送携带源 revision 和目标 header 的可选幂等迁移请求；服务端仍需提供事务 endpoint 和回滚约定，返回 404 时客户端继续使用内存回退。

## 验证

逻辑 catalog 测试覆盖 header 分类与投影、新版本拒绝、未知 header 键、稠密序号强制、方言归一化与排序、prompt 提升、seed 截断合成、外部会话投递标记、退役词汇、与物理路径共享的畸形探针，以及流式形态。协调器、Gateway 和 SQLite 契约 spec 端到端覆盖该 catalog，包括 body 重写发布与纯元数据后继。
