# Agent Note: 历史目录补全将显式子证据绑定到 V6→V7

Status: implemented

[English](2026-10-19-historical-catalog-completion.md) | 中文

## 问题

V6 父会话的 `subagent/catalog` 事实记录的是写入时它已知的直接子会话。把该父会话恢复到 V7 时必须从保留的子日志本身补齐目录缺口；仅有父会话无法恢复它从未记录的子 id、创建时间或描述符。静默地不提供证据会在恢复后的会话中丢掉真实子会话，并让列表看不到父会话从未写入头部的后代。

## 决策

经由 `sessionFormatV6ToV7` 的历史正文恢复要求显式子证据。共享的默认迁移边在没有该绑定时拒绝正文恢复，因此没有任何恢复路径会静默产生不完整的目录；空数组显式声明无子父会话。`createSessionFormatV6ToV7(children)` 绑定单个父会话的证据；`createSessionFormatCatalogWithChildren` 与 `createCoharnessJsonlFormatCatalogWithChildren` 为其组装目录，后者在同一条绑定边上保留 CoHarness v0–v3 方言准入。

`dsh-session-persistence-jsonl` 在 `catalog-migration.ts` 中收集该证据：通过 `historicalSessionFormatCatalog`（带方言支持的 V0–V6）读取每个保留的直接子会话，提取其 `subagent/descriptor` 事实，见证子会话的物理身份，并把损坏或不可读的子会话隔离为 `unavailable` 事实而不是让父会话失败。准备好的迁移在服务或发布前再次校验每个见证身份；读打开期间的 `JsonlGenerationSourceChangedError` 触发一次重收集重试。

随之有两项读取侧行为变化。历史 `stat` 与 `list` 的修订号现在折叠 `historicalCorpusRevision`——对排序后的选定代次路径及其物理身份计算 SHA-256——因此子成员或内容变化会使缓存结果失效。列表枚举经由有界限制器（`listConcurrency`，默认 3），项目扫描、头部读取、stat 调用与语料哈希共享该限制；`list` 跳过外来或损坏工件，而定向打开仍拒绝它们，`SessionLogScanner.finish` 对每次存储日志读取断言已发布的 V7 生命周期关系。

## 备选方案

**让默认边把缺失证据当作空子集接受。** 否决：静默空集正是要消除的缺陷。仅头部迁移保持无条件；无证据的正文迁移显式拒绝，使读取路径不会漂移。

**迁移时仅扫描语料发现子会话而不留见证。** 否决：收集与发布之间语料可能变化，因此每个子描述符绑定产生它的物理文件身份，并在提交点重新校验。

**在 `historicalSessionFormatCatalog` 内让遗留头部继续走 released codec。** 否决：保留的 CoHarness v0–v3 子会话携带方言帧，因此历史目录通过当前读取器使用的同一 `createCoharnessJsonlCatalog` 分派，把遗留头部交给方言目录、released 头部交给 released 目录。

## 影响

V6→V7 的读取与发布产生的父目录反映保留的子语料，包括显式声明的空集。`sessionFormatCatalog` 与 `coharnessJsonlFormatCatalog` 对头部与当前代次读取仍然有效，但在未绑定子证据时拒绝历史正文迁移；逻辑后端使用 `sessionLogicalFormatCatalog`，其存储元数据本身就是完整证据。被删除或改写的子会话会使定向读取失败，而不是静默改变恢复的父会话。

## 验证

`catalog-migration.spec.ts` 覆盖 V0–V6 源的父子组合、保留源的发布、畸形原生目录行、外交付标记、重复目录、成员与内容修订失效、消失与修复的子会话、不透明后继代次、损坏子隔离与路径诊断、缺失或多重描述符、不支持的子代次以及同读重收集。`children.spec.ts` 锁定默认边的拒绝与绑定证据契约；`generation.spec.ts`、`jsonl.spec.ts` 与 `zstd.spec.ts` 覆盖有界列表、读重试、容忍损坏的枚举与当前代次生命周期校验。
