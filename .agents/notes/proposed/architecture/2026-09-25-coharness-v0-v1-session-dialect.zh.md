# Agent Note: CoHarness v0/v1 Session 方言准入

Status: proposed

[English](2026-09-25-coharness-v0-v1-session-dialect.md) | 中文

## 问题

alpha.2 持久层 replatform 让存量 Session 经由 `sessionLogicalFormatCatalog` 迁移，各代边界按 released 词汇表校验。网关写入的 SQLite/PostgreSQL Session 记录了 released v0/v1 键集从未命名的成员。对生产会话库的只读扫描显示 90 个 Session 中 61 个迁移被拒：`permission/preset.origin`（`default`/`selection`/`inferred`）、盖着 `version: 2` 的 `subagent/descriptor`、消息 `source.documents` 附件列表、`source.participant.scope.canManage`，以及所有 released 代都不认识的 `userdoc/attached` 事件类型。

同一批事件在穿过的后续边上还会再次失败：`permission/preset` 键集在 v2 stage 的 `assertEvent` 内再次被断言，released v1→v2 stage 对未知事件类型直接拒绝。这些成员无法自然通过，也不能丢弃——它们全部是当前 schema 的现行词汇。

## 提案

把 v2 边已在使用的方言机制扩展到 v0 和 v1 边，共享一份成员台账：

- `coharness-dialect-members.ts` 在 released 准入前隐藏方言成员，发射后回填。`permission/preset.origin` 与 `source.participant.scope.canManage` 先校验再回填；`source.documents` 仅在 `kind: 'user'` 源上隐藏（released 键断言只作用于该处）；`subagent/descriptor` `version: 2` 重写为 3，因为 v3 schema 冻结的字段集完全一致。
- `coharness-v0-dialect.ts` 包装 released v0→v1 stage——每个准入输入恰好发射一个事件且按序，FIFO 台账可确定性回填。
- `coharness-v1-dialect.ts` 包装 released v1→v2 stage；承载成员的类型在该边同样按序一一发射，发射边界按类型匹配队首台账回填。
- 纯方言类型（声明的 `version: 1` 形态 `userdoc/attached`）完全绕过 released 准入，就地发射，并在 v2 方言边获得输出位置——该边对它们跳过密度检查与引用映射写入：没有任何引用指向它们的 seq，released stage 的重排序也容纳不了它们。
- v2 方言 stage 在 `assertEvent` 前执行同样的隐藏，并在 `emitMapped` 内按 source seq 回填，同时覆盖从前面的边流来的成员与直接以 v2 存储的会话。

畸形方言负载仍然被拒：未声明的 origin、未声明形态的 `userdoc/attached`、超出声明戳的 descriptor 版本都响亮失败，不会扩大准入口径。

## 考虑过的替代方案

**放宽 released v0/v1 键集以容纳 CoHarness 成员。** 这会为所有消费者扩大上游准入口径——包括从未产生过这些成员的物理 JSONL 读取——并且改动了 replatform 原样采纳的 released 校验器。

**迁移时丢弃这些成员。** `origin`、`documents`、`canManage` 与 `userdoc/attached` 都是当前 schema 的现行词汇；丢弃会静默降级当前运行时仍在消费的存量 Session。

**改写存储行来完成迁移。** Session 数据遵循不可变代次规则；改写已提交行会把归一化与存储变更混为一谈，并丢失区分"存了什么"与"链路产出什么"的能力。

## 验收标准

- 此前仅因已声明方言成员被拒的数据库 Session 全部通过 `finish` 校验；生产库达到 90/90。
- 畸形方言负载——未声明的 origin、descriptor 戳、`userdoc/attached` 形态、未知类型——仍然被拒。
- 物理 catalog 保持纯 released 准入；方言成员不会渗入 JSONL 工件读取。

## 风险

成员在 released 边之后回填，下游不再重新校验；各方言 stage 在隐藏前先校验每个成员，畸形方言负载无法搭车通过。纯方言事件占用 released stage 从未编号的输出位置；v2 stage 的密度跳过仅限已声明方言类型，新出现的未知类型无法利用该豁口。未来若有按发射顺序重排序号的 released 边，必须先把 source-seq 台账重新键入，再做 v2 回填查找。

## 影响

- 90 个存量数据库 Session 全部通过逻辑 catalog 读取；此前被拒的 61 个恢复迁移，包括最大生产项目的历史。
- 物理 catalog 维持纯 released 准入：JSONL 工件始终以 released 词汇写盘（146 个 v0 文件已验证），方言仅限逻辑路径。
- 一个已知坏件保留：`isSeeded` 存在之前写出的 header-only `session.v2.jsonl.zstd` 无法通过 released v2 物理头校验，保持不可读；它不含任何事件，也没有内容可迁移。
- 已实施的 replatform 笔记中"仅 v2 边运行方言准入"的陈述已就地更新。

## 验证

- 生产会话库只读扫描：90/90 Session 通过链路 `finish` 校验（修复前 29/90）。
- `vitest run packages/session/session-format-catalog`：147 个测试通过，含 9 个新用例，覆盖 v0/v1 的 `origin` 保留、descriptor 戳重写、直接源与 inserted 源的 `documents`/`canManage` 往返、`userdoc/attached` 携带，以及对未声明 origin、descriptor 版本、`userdoc/attached` 形态和未知类型的拒绝。
- `vitest run packages/session/session-persistence`：200 个测试通过。
