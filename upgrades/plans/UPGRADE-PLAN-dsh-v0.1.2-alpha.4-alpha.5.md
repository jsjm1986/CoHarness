# CoHarness 对齐 deepseek-harness dsh-v0.1.2-alpha.4 / alpha.5：升级核对与适配记录

- 审查日期：2026-09-02 至 2026-09-03
- 我方基线：`4cb550ba86`（分支 `feat/upstream-alpha45-sync`，与 CI 可移植 runner 修复栈同基；PR #116 合并后 rebase 到 `master`）
- 上游版本：[`dsh-v0.1.2-alpha.4`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.4)（`4e84901e6471b79ec0338099867ebb4606d12bb5`）、[`dsh-v0.1.2-alpha.5`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.5)（`db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`）
- 对比统计：alpha.3→alpha.4 为 2389 个文件、31107 行新增、23242 行删除（13 个 first-parent 合并、259 个非合并提交）；alpha.4→alpha.5 为 280 个文件、1752 行新增、305 行删除（2 个 first-parent 合并、5 个非合并提交）。统计使用 `git diff --no-renames --shortstat`，只用于范围确认。
- 祖先关系：上游 tag 与 CoHarness `master` 没有共同 Git ancestor。本轮首次采用**文件级三方合并**（`git merge-file`，base = 上游 alpha.3 版本、ours = fork 版本、theirs = 上游 alpha.5 版本）代替逐条目的手工语义移植：fork 相对 alpha.3 的增量与上游 alpha.3→alpha.5 的增量在文件级自动合并，重叠处留冲突标记逐块裁决；fork 与 alpha.3 一致的文件直接取 alpha.5 版本；fork 自有包靠 `typecheck` 报错逐点适配。合并脚本结果：快进 78 / 干净合并 167 / 冲突 245（src 101、tests 76、md 60、scripts 7、`bundle/base/cordis.patch.yml` 1；491 个冲突块）/ 删除 7 / 新增 12 / 跳过 1899（invariant 伴生、package.json、snapshots、生成文档、Agent Notes 等另行处理）。
- 版本策略：CoHarness DSH 发布族统一升到 `0.1.2-alpha.5.coharness.1`，代码基线对应上游 `dsh-v0.1.2-alpha.5`，发布 tag 为 `dsh-v0.1.2-alpha.5.coharness.1`；范围与 alpha.2/alpha.3 记录相同（workspace 根、可发布 `packages/*/*`、`apps/cli`、`apps/web`、`packages/experimental/*` 私有包）。`apps/android-shell` 继续 `0.1.0`，vendor/native 发布族继续独立版本线。该版本表示同步代码基线，不代表与上游发行版二进制兼容。

## 1. 结论

alpha.4 是一次协议/API 层面的升级：`Session.events` 被按需读取 API 取代、`SessionSeq`/`SessionLogOffset` 品牌类型贯通整条 session 栈、`report` 工具被双向 `send_message` 取代、持久化 header 从 `seedLength` 改为 `{ meta.isSeeded, inheritedEventCount }`。这四项都触及 fork 自有的 ApiProxy history-wire、Gateway/SQLite 持久化后端和 UI façade，因此本轮的主体工作是**让上游协议变更贯通 fork 自有包**而不是挑选功能条目。alpha.5 只有一个升级路径修复（#3438），其前提是上游 per-record 投影缓存布局，fork 未采纳该布局，判定为不适用并以 fork 自身架构内的等价措施覆盖同一风险。

用户在 2026-09-02 22:35 决策卡 `up45-scope` 中拍板五项范围：① `Session.events` 采用新 API 并**保留 `events` 为 `@deprecated` 兼容 getter**；② 品牌类型**全量贯通**含 fork 自有包；③ invariant 伴生清理（#3367）**拆为后续独立 PR**；④ `code-runtime-python` **整包替换**为上游 experimental 版；⑤ `web_fetch` **跟随上游默认开启**。本记录按此范围执行。

## 2. 二开保护条件

以下事实在本轮适配中保持不变（延续 alpha.2/alpha.3 记录）：

- `gateway/` 仍是唯一授权源；**Gateway 线上会话头继续使用 `seedLength` 字段**（Gateway schema 是权威），`session-persistence-gateway` 新增 `GatewayWireHeader` / `wireHeader(storage)` / `storageFrom(value)` 在线上头与新的 `SessionStorageMetadata` 之间双向映射。
- `packages/host/apiproxy`、`packages/client/connection`、`packages/client/runtime` 的 history-wire、projection 水位、participant、文档/附件字段和重连顺序不被上游 Remote API（`api/{session,settings,workspace}-controller`、`RemoteError`、`subagent/src/control.ts`）替换。浏览器→子代理的消息投递改走上游为宿主适配器提供的 `queueHostSubagentPrompt`（`@deepseek-ai/dsh-subagent/internal`），Remote 控制面继续不采用。
- `SESSION_FORMAT_VERSION` 继续为 `0`；`SessionEvent.ignorable` 继续保留；Session SQLite 后端保留并完成 `seed_length` 列到 `{ isSeeded, inheritedEventCount }` 的映射；`session-projection-cache` 的整介质 version 3 布局保留。
- `ui-conversation` 继续是 fork 的 UI façade：`ConversationRoot` / `InputBar` 三座位结构、`slots.ts` 的 `owner: InputZone` 共享、`TrajectoryView` 自有虚拟化、服务端历史窗口、文档中心与工具卡不被上游 `ui-chat` / `ui-trajectory` 结构覆盖。
- 新增模型可见字段仍只来自 Session 事件、持久投影或已授权 wire frame。`send_message` 的内容经 `queueHostSubagentPrompt` 入队后由 subagent 包的 steer 服务写入子会话日志，不新增浏览器直达路径。

## 3. Release body 逐项处置

### 3.1 alpha.4

| 上游条目 | 处置 | 当前代码证据与判断 |
| --- | --- | --- |
| 父 Agent 与可持续子 Agent 通过 `send_message` 双向传递后续消息，取代单向 `report`（#3250） | 已适配 | `packages/subagent/subagent/src/{index,internal,continuation,list-children}.ts`：删 `reportFrom` / `registerContinuableSetup` / setup registry，`[queueSubagentPrompt]` 由 private 改 `@internal` 公开，`package.json` 新增 `./internal` 子路径导出；`tool-subagent-control` 的 `send_message` 以 `agent_id` 定位目标并按 Steer 语义投递（工作中的目标在最近的 step 边界收到，空闲目标开新轮次）；整包删除 `packages/subagent/tool-subagent-report` 与 `examples/acp-agent/subagent-report.*`、`bundle/base` / 两个示例 `cordis.yml` / `cordis/standard` 预设 / `tsconfig.host.json` / `knip.json` / `examples/package.json` 去引用；`host/apiproxy/src/api-proxy.ts` 浏览器→子代理 prompt 从 `ctx.subagents.followup(...)` 改为 `queueHostSubagentPrompt(ctx.subagents, parent, child, content, source, signal)`；`experimental/agent-team` 同步；`tsconfig.base.json` 加 `@deepseek-ai/dsh-subagent/internal` 显式 paths（fork 通配不覆盖子路径）。上游 `subagent/src/control.ts`（Remote 控制面）继续不采用。 |
| 自定义模型发现复用 Profile 请求头（#3403） | 已适配 | fork 的 `llm-pi-ai.discoverModels` 是 `dsh-llm.discoverModelsAtEndpoint` 的薄包装，因此在 `packages/llm/llm/src/discovery.ts` 的 `LlmEndpointModelDiscoveryRequest` 新增 `headers?`（`accept` / 协议鉴权 / attribution 保留名不可覆盖）；`llm-pi-ai` 侧 `StoredModelDiscoveryProfile { headers, resolveApiKey }` 替代裸 `storedApiKey`，`resolveApiKey` 保留 fork 的 `{ value }` 解包；`config.ts` 的 `assertValidHeaders` 干净合并。 |
| 模型目录支持搜索与筛选（#3403） | 已适配 | `packages/client/ui-settings-models/src/client/ModelListEditor.tsx` 合并上游 `candidateQuery` 可搜索 picker（全选只作用于可见项），保留 fork 的 `useId`；headers 无页面编辑器（README 已注明）。 |
| 界面圆角 / 描边 / 轮次导航 / 投影效果（#3411、#3415） | 已适配 | `packages/client/ui-theme/src/styles/{corner-shape,gradient-shadow-text}.css` 与 per-element elevation token 新增；38 个冲突 CSS module 以 fork 的 token 化版本为底叠加上游属性级改动（`1px`→`0.5px` 描边、`border-radius` 映射到 fork `--dsw-radius-*` 刻度、插入 `corner-shape: round`）；上游 #3411 三条样式守卫（`ui-theme/tests/{corner-shape,elevation}-styles.client.spec.ts` 扫全仓 CSS）套用到 fork 自有 CSS：60 处 `1px solid` 边框改 hairline、7 处「阴影 + 中性边框」改 `border: 0` + elevation token、13 处全圆角补 `corner-shape: round`；`ui-conversation/src/client/chat/TurnNavigator.module.css` 预览层 z-index 高于代码 banner（#3415）。**视觉复查项**：上游同步把整框描边加深到 l4，fork 自有文件只改宽度未跟色阶。 |
| 超长会话在流式回复、布局、导航预览场景的渲染开销优化（#3391） | 部分适配 | 已采纳：`client/runtime` `conversation-assembler.ts` 的 `buildLocationData(context, scope, previous)` 恒等复用（`if (previous === next) continue`）与 `ui-deliverables/turn-deliverables.ts` 的 `return previous` 分支、`flush()` 返回真实 `published` 标志；`ui-slots` / `ui-renderer` 的 inject `keyedHooks` 隔间（`standardHookPropName` / `KeyedStandardSource` / `keyedObservableHook` / `bindInjectSources`）；`InputBar` `memo()`；`ui-deliverables/ProducedFiles` 改为 CSS 容器分段（删 `fitProducedFiles` JS 量宽）。**有意不采用**：`ui-trajectory` 驻留分页 `HISTORY_PAGE_NODES`（fork 有服务端历史窗口 + 自有虚拟化，P1 e2e 已按 fork 行为适配；`TrajectoryView.tsx` 与其测试整体保留 fork HEAD）；composer 座位归属迁移（`conversation.input.{overlay,left,right}` / `conversation.composer.dock` 的 parent 改到 `composer.bar`、去掉 `owner: InputZone`）——`owner: InputZone` 是插件可见契约，fork `ConversationRoot` 仍按三座位渲染并作为 props 传给 `InputBar`，`apply.ts` / `slots.ts` 保留 fork 版本；`ChatNodeStore` per-node observable `source()`（fork store 无此方法、src 无调用方）。上游 `ui-chat` 内的流式两帧发布、滚动几何采样节流、CSS 化 reasoning 对齐属于 fork 无对应包的文件，`ui-conversation` 保留自有实现。 |
| Python SDK / Headless / ACP / 自定义 Profile 默认提供 `web_fetch`（#3382） | 已适配 | `packages/bundle/base/cordis.patch.yml` `web` 行加 `fetchProvider: http` 并新增 `web-fetch-http` 行（`package.json` 加依赖，`base.spec.ts` 断言随上游合并）；fork 三个预设 `apps/cli/config/agent-presets/{code,cordis,standard}/agent.cordis.yml` 的 `tool-web.fetch: true`（上游无对应文件，手工移植）；`bundle/web-app/cordis.patch.yml` 仍 `tool-web disabled: true`，Web 应用由预设暴露。fork 2026-08-29 已做 `web-fetch-http` 公网地址 pinning（防 SSRF / DNS rebinding），rc.2 基线「不挂 provider」的理由已消除。ACP keyless snapshot 的工具 schema 钉住值随之重录。 |
| Web PTC Mode 默认不再暴露通用 `workflow` 工具（#3425） | 已适配 | fork `code` 预设（= 上游 `ptc`）`tool-workflow` 行 `disabled: true`（保留 workflow engine 给 ralph）+ 头注释同上游；`ui-agent-preset/locales.ts` 保留 fork 键名 `presetCode*`、描述采上游「不含 workflow 工具」文案。 |
| `Session.events` 被按需读取 API `seq` / `eventAt()` / `snapshotEvents()` 取代（#2907） | 已适配（含兼容层） | `packages/core/session/src/index.ts` 采纳 `seq` / `eventAt()` / `snapshotEvents()` / `ownEvents()` / `isOwnSeq()` 与不可变快照复用；**新增 `@deprecated get events()`** 返回 `snapshotEvents()` 的缓存快照（零性能代价，树外插件 `dsh-model-governance` / `dsh-directory-guard` / Gateway 不破坏）；fork 自有包 48 处 / 20 文件机械迁移到 `snapshotEvents()`（`inbox` 用 `ownEvents()`）；`hasOpenTurn` 按 `seq` / `eventAt` 倒扫。`session.md` 的生成区域随 `gen-cordis-catalog` 更新。 |
| `SessionSeq` / `SessionLogOffset` 强类型区分（#3346） | 已适配（全量贯通） | `packages/util/brand` 新增 `BrandedNumber<B>` 类型，**不**引入上游运行时 `brandNumber` / `brandString`（fork brand 包是纯类型，各包用 cast 工厂）；品牌贯通 `core/session`、`session-persistence{,-jsonl,-sqlite,-gateway}`、`session-projection{,-cache}`、`session-title{,-llm}`、`subagent*`、`core/agent`、`agent-loop`、`token-meter`、`goal`、`schedule`、`compaction*`、`session-reference`、`host/apiproxy` history-wire、`archive-gateway`、`scripts/session-sqlite-migration.ts`；client 侧 `ConversationNode.seq` 与上游一致保持 plain number。持久化 header 形状随之从 `seedLength` 改为 `{ meta: { isSeeded }, inheritedEventCount }`：JSONL v0 物理 header 的 `seedLength` 字节兼容解码；SQLite `rowToStorage()` 由 `seed_length` 列还原、`writeRow` 写 `isSeeded ? inheritedEventCount : null`；Gateway 线上头保持 `seedLength`（见 §2）。 |

### 3.2 alpha.5

| 上游条目 | 处置 | 当前代码证据与判断 |
| --- | --- | --- |
| 从 `0.1.1-rc.2` 或 `0.1.2-alpha.3` 升级时应用可能启动失败或会话列表标题丢失（#3438 `projcache-cross-version-read-compat`） | 不适用（有意不采用） | 上游修复依赖 alpha.2/alpha.3 引入的 per-record 投影缓存布局（`storage-json/per-record-unit.ts`、`storage-domain` `layout`），`compatibleVersions` / `invalidRecords` / `backupRecord` 全是 per-record 特性；fork 在 alpha.2/alpha.3 同步时有意未采纳 per-record layout，`session-projection-cache` spec 仍是整介质 version 3。三处冲突（`storage-domain/src/spec.ts`、`storage/src/backend.ts`、`storage-json/src/format.ts`）取 fork；干净合并但引入死代码的 `storage-domain/src/index.ts`、`storage/src/backend.ts` 及两份 storage 测试还原；删除合并带入的 `session-projection-cache/tests/fixtures.spec.ts` + `tests/fixtures/`（per-record v3→v4/v5 与 `.json.bak` 备份跳过用例）。**fork 架构内的等价措施**：projection-cache identity 采纳 `identityOf(meta, inheritedEventCount)` 但把 lineage 字段（`isSeeded` / `inheritedEventCount`）设为可选且**不升 medium 版本**——缺字段读作 unseeded lineage，未 seeded 会话的旧缓存行继续可用、seeded 会话自动重折，不会出现启动失败或标题丢失；fork 整介质版本升级路径是「整体丢弃重折」（安全但慢）。是否日后采用 per-record layout 留作独立决策点。 |

## 4. Release body 之外的范式/基础提交

| tag / 提交 | 代码主题 | CoHarness 处置 |
| --- | --- | --- |
| alpha.4 `5dd876025d`（#2907） | Session log 按需读取 API、不可变快照复用 | 采纳并保留 `events` 兼容 getter（§3.1）。 |
| alpha.4 `9d15938073`（#1148） | `code-runtime-python` 从 `packages/code-runtime/` 迁至 `packages/experimental/` 并扩到约 13k 行（settlement / backlog / load-dispatch 健壮性） | **整包替换**（用户决定 ④）：`git rm -r packages/code-runtime/code-runtime-python`，导入 a5 的 `packages/experimental/code-runtime-python/` 全部 15 个文件。fork 适配：`snapshotJsonValue` 改自 `@deepseek-ai/dsh-session`；`private: true`；保留 `./invariant` 导出与 `lib/invariant.js`（#3367 拆 PR），新写说明性空 `src/invariant.ts`；`tsconfig.json` references 改 session/timeout/invariants；`tsdown.config.ts` 双入口。根配置：`tsconfig.host.json`、`tsconfig.base.json`（显式 paths ×2）、`vitest.config.ts` Windows 排除表、`knip.json`、`scripts/check-workspace-constraints.ts`、`scripts/verify-package-readme-model-experience.ts`、`scripts/gen-doc-graphs.ts`（codeRuntime seam implementations 改为 `['code-runtime-worker-thread', 'experimental-code-runtime-python']`）。该包要求 CPython ≥ 3.10（与 CI `setup-python 3.10` 一致）。 |
| alpha.4 `714bec1316`（#3367） | 删除约 150 个包的空 `invariant.ts` 伴生与 `./invariant` 导出、规则改为「只有能比较可分叉观测的才发布」 | **拆为后续独立 PR**（用户决定 ③）：本轮不动 `invariant.ts`、`package.json` 的 `./invariant` 导出、`dsh-invariants` peer/dev 依赖；新导入的 experimental python 包也按 fork 现行规则补伴生。 |
| alpha.4 `52af48f808`（#3250） | Steer service、`send_message`、删 `tool-subagent-report` 与 `activation-setup-registry.ts` | 采纳（§3.1）；Remote `control.ts` 不采用。 |
| alpha.4 `68488c552a`（#3403） | 模型发现 headers、`assertValidHeaders`、`ModelListEditor` 搜索 | 采纳（§3.1）；fork `model-access` / `model-provider-config` 自有包不受影响。 |
| alpha.4 `dead2b2324`（#3382） | `bundle/base` 默认 `web_fetch`、snapshots 重录 | 采纳（§3.1）。 |
| alpha.4 `4bc0b000f5`（#3411）、`3efd4b51e0`（#3415） | superellipse 圆角、elevation token、~80 个 CSS module 微调、预览层 z-index | 采纳并把守卫规则套用到 fork 自有 CSS（§3.1）。 |
| alpha.4 `876a3e0414`（#3346） | `SessionSeq` / `SessionLogOffset` 品牌、`SessionStorageMetadata` / `SessionInspection` / `SessionEventSuffix`、`inheritedEventCount` | 采纳并贯通 fork 自有后端（§3.1）；`gen-cordis-catalog.ts` 只加 4 个 seq 类型 + `SessionEventSuffix` + `AgentMessageSource`（fork 无 Remote API 符号），`type-equiv.manifest.json` 加 4 个 seq 条目。 |
| alpha.4 `c3e5bd7dae`（#3418） | Agent Note 文档链接 | 不适用。 |
| alpha.4 `1f694c88ab`（#3391） | 长会话渲染开销 | 部分采纳（§3.1）。 |
| alpha.4 `3c5b7097ae`（#3425） | PTC preset 关闭 `workflow` 工具 | 采纳（§3.1）。 |
| alpha.4 `4e84901e64`（#3427）、alpha.5 `db6bdc3576` | 版本号 | 以 fork release 脚本语义统一升到 `0.1.2-alpha.5.coharness.1`（§6）。 |
| alpha.5 `1915665e1e`（#3438） | projection cache 跨版本读兼容 | 不适用（§3.2）。 |

### 4.1 其他提交簇的语义等价与取舍

| 上游提交簇 | 判断 |
| --- | --- |
| `@deepseek-ai/dsh-util-values` / `dsh-util-time` 等共享工具包 | 继续不引入。解冲突时按固定映射改写：`deepFreeze` / `assertNever` → `@deepseek-ai/dsh-llm`；`JsonValue` / `snapshotJsonValue` / `isJsonValue` → `@deepseek-ai/dsh-session`（`json.ts`）；上游 `ToolCallId` 在 fork 已存在（`CallId` 为别名）；上游 `brandString(...)` = fork 各包自己的工厂。 |
| 上游 `ui-chat` / `ui-session` / `ui-approval` / `store` focused 包、`session-turn-outline`、`api/*-controller`、`bundle/{acp-app,sdk-app,sdk-minimal}`、`webhook/*` | fork 无对应包，行为已由 `ui-conversation` / `client/runtime` / `host/apiproxy` 承载；352 个上游独有包文件不复制。 |
| 上游删除的测试与 fork 有意删除的测试 | 合并重新带回的 fork 已删测试不回收：token-meter route pricing、goal-round-driver `request/header reason === 'series'`、ui-trajectory turn rail、projection registry `hydrate`、session-title `titleInput`、`util/brand/tests/brand.spec.ts`（引用运行时 `brandNumber`）。fork 自有断言保留：`permission/preset` 的 `origin: 'default'`、`ok({ models })` 发现结果形状、`InputBar` 三座位、`foldPlanMode`、`resolveSessionPreset`、`SqliteSessionPersistence` 替换上游 Jsonl。 |
| snapshot 子级 sidecar pin | `report` 工具被 `send_message` 取代后，可继续子会话的 system prompt / tool schema 与父级逐字节一致，`subagent-continuable`、`subagent-continuable-inheritance`、`subagent-list-agents` 三个场景删掉 `pinsChildToolSchemas: [1]` / `pinsChildSystemPrompts: [1]` 与 6 个 sidecar（未声明 pin 时 harness 直接用 class pin 校验子级 header，等价性仍受测）；`subagent-current-model` 子级 prompt 因模型名不同保留 `pinsChildSystemPrompts`。 |
| `subagent-continuable` 场景按 Steer 语义重新编排 | 旧 authored transcript 假设两次 `send_message` 以 `followup` FIFO 排成子会话 turn 2 / 3，且参数名仍是 `subagent_id`。新语义下运行中的目标在下一个 step 边界领取消息，两条消息会被同一 step 一起领走，turn 3 永不出现。改为：`input.json` / `session.jsonl` / `stdout.expected.jsonl` 的 `subagent_id` → `agent_id`；fixture `subagent-durability-failure.ts` 从 `followup.bind` 改为 `sendMessage(sender, targetId, …)` 并重排栅栏——子会话 turn 1 不设栅栏，完成后 Activation 结算、「finished」通知 steer 进忙碌父级的 turn 1（父级 step 2 等该通知进入 inbox 后才发第一条 `send_message`，通知固定在 step 3 被领取）；第一条 `send_message` 冷恢复已结算的子会话开 turn 2（pre-step 栅栏等 3 条 inbox 插入 + 父级 turn 1 关闭）；第二条到达运行中的子会话，在 turn 2 step 2 边界领取，此时子会话累计领取第 3 条消息，`session/flush` 抛 `snapshot disk full`（按 `agent/inbox/claimed` 计数触发，不再按 turn 号），turn 2 以 error 关闭，「failed」通知到空闲父级开 turn 2。`waitForSubagentTurnEnd.minimumTurn` 3 → 2。transcript 因此同时覆盖 Steer 的两条路径（空闲/缺席目标开新轮次、运行中目标在 step 边界领取）与忙碌父级被 steer 而非唤醒的结算投递。 |
| CI / Windows / release metadata 提交 | 不把 CI 平台差异伪装成产品同步；本地只跑静态/聚焦门禁，Windows / 真实 API / 浏览器组装证据单列。 |

### 4.2 同步过程中发现并修正的 fork 侧回归

- `session-persistence/src/coordinator.ts` `loadLiveSnapshot` 空事件判定加回 `&& !state.materialized`（上游 a3 / a5 都有，fork 在 alpha.2/alpha.3 同步时丢失；`ensureMaterialized` 后的空会话必须可 `load`）。
- `subagent/src/list-children.ts` 恢复 alpha.2/alpha.3 同步时丢失的 seq gate（live 路径 `candidate.live.isOwnSeq(identity.seq)`、冷路径 `identity.seq < inspected.inheritedEventCount`）与 `LIFECYCLE_WITNESS_KEYS` 的 `origin` / `agentPreset`（SQLite / Gateway 后端都持久化这两字段）；「seed 回放祖先 descriptor 也列为 child」的已知偏差随之消除，对应测试改为上游语义「仅有继承段 descriptor 的 fork 判 corrupt」。
- `permission-presets/src/index.ts` `apply()` / `pinInitialPermission()` 改用包内 `foldKnobs` 的 approval 结果（上游删除了 `effectiveApprovalPolicy`；与 `effectiveSandboxMode` 对称）。
- `client/runtime` `conversation-assembler.ts` `flush()` 增量路径原本无条件 `return true`，改为按是否有 view 被 `apply` 返回，与 JSDoc 及上游语义一致。
- `agent-team/persistence.spec` 的 `persistedChild` 在批量脚本迁移时被错转成 `isSeeded: true`，还原为 `isSeeded: false`（seed 是子会话自己的引导轮）。
- `ui-conversation/service.ts` `loadHistoryUntil` 补 `@param` / `@returns`（`gen-cordis-inspect-catalog` 抓到，HEAD 即有）。

## 5. 已落地文件簇

- Session 协议：`packages/core/session`、`packages/util/brand`、`packages/session/session-persistence{,-jsonl,-sqlite,-gateway}`、`packages/session/session-projection{,-cache}`、`packages/session/session-title{,-llm}`、`packages/session/session-telemetry{,-otel}`、`packages/session/session-log-deepseek`、`packages/session-query/*`、`packages/context/archive-gateway`、`scripts/session-sqlite-migration.ts`。
- Subagent / steer：`packages/subagent/{subagent,tool-subagent,tool-subagent-control,subagent-fork-in-process,subagent-in-process-driver}`、删除 `packages/subagent/tool-subagent-report`、`packages/host/apiproxy`、`packages/experimental/agent-team`、`examples/{acp-agent,headless-agent}`、`packages/bundle/base`、`apps/cli/config/agent-presets/*`。
- Agent 与读模型：`packages/core/{agent,agent-loop,tools}`、`packages/interaction/{permission-presets,user-approval,commands}`、`packages/goal/*`、`packages/schedule/schedule`、`packages/llm/token-meter`、`packages/compaction/*`、`packages/context/{session-reference,time-context,agent-instructions}`、`packages/todo/tool-todo`、`packages/plan/plan-mode`。
- LLM：`packages/llm/llm/src/discovery.ts`、`packages/llm/llm-pi-ai`、`packages/llm/llm-retry`、`packages/client/ui-settings-models`。
- 客户端：`packages/client/ui-theme`、`packages/client/ui-conversation`、`packages/client/runtime`、`packages/client/ui-deliverables`、`packages/client/ui-slots`、`packages/client/ui-renderer`、`packages/client/ui-primitives`、`packages/client/ui-tool`、`packages/client/ui-agent-preset`、26 个 fork 自有 CSS module（hairline / elevation / corner-shape）。
- 实验包：`packages/experimental/code-runtime-python`（新位置，15 文件）、`tsconfig.{host,base}.json`、`vitest.config.ts`、`knip.json`、三个 scripts。
- 文档与生成物：30 篇上游改动的英文 README / docs 逐 hunk 语义补丁（en + zh）、`.agents/notes` 导入 14 篇 a5 Note、删 3 篇 report 系列 Note、整文件快进 12 篇 + 段落级快进 12 篇分叉 Note、11 个生成器输出（Cordis catalog / api-catalog / slot-catalog / tool / config / persistence catalog / scoped-events / 8 张 composition 图 / module graph / third-party notices）、`verify-translation-pairing --write` 1157 对。
- 快照：`examples/acp-agent/tests/snapshots/**` 与 `examples/headless-agent/tests/snapshots/**` keyless refresh 重写（`send_message` schema、子会话日志），删 `subagent-report` 场景。

## 6. 验证证据

同步过程中已执行并通过（macOS 源码/产物平面，日志在 `/tmp/up45/*.log`）：

```text
CI=true pnpm run typecheck            # tsc -b host + tsdown host + tsc -b client，0 错
CI=true pnpm run lint                 # oxlint 0 问题（首跑 64 个：52 处遗留 session.events → snapshotEvents()/eventAt()、8 处批量脚本导致的 max-len、2 处多余断言、1 处 unbound-method、1 条失效 disable 注释，全部修正）
CI=true pnpm run doc-sync             # 28/28 叶子通过（首跑 6 个失败：generated 目录的 .zh.md 未随英文重生成、4 个 type-equiv 块漂移、14 对 i18n 哈希未重录，全部修正）
CI=true pnpm run build:lib:client     # 160 个 client 面 bundle 通过（publint 需要 lib/ 产物）
CI=true pnpm run hygiene              # rescope / knip / publint(248) / constraints / licenses(252) / package-invariants(248) / built-package-invariants(248) / cordis-config(137) / node-next-types(257) / optional-imports / runtime-closure(4 预设 131 包) / package-dependencies(264 包 633 边) / client-packages(50) / plugin-surfaces / vendored-links 全部通过
CI=true pnpm run release:verify --family dsh   # 247 个成员统一 0.1.2-alpha.5.coharness.1，发布顺序可解
npx vitest run <115 个含 src/tests 改动的包目录>   # 604 文件 / 10186 用例通过（vitest-focused-3.log + 两处后续修正的单文件复跑）；lint 修正涉及的 22 个测试文件 612 用例复跑通过
npx tsc -b packages/experimental/code-runtime-python && npx vitest run packages/experimental/code-runtime-python   # 0 错；283 通过 / 2 跳过（CPython 3.12）
11 个文档/目录生成器（gen-cordis-catalog --write … gen-third-party-notices）   # 全部 exit 0
npx tsx scripts/verify-translation-pairing.ts     # 1162 对一致
DSH_SNAPSHOT=refresh vitest run --config vitest.snapshot.config.ts examples/acp-agent/tests/acp.snapshot.ts examples/headless-agent/tests/headless.snapshot.ts   # 重录（分两批）
vitest run --config vitest.snapshot.config.ts examples/acp-agent/tests/acp.snapshot.ts examples/headless-agent/tests/headless.snapshot.ts   # 并发 5 replay：acp 93/93 通过（含 snapshot fixtures 守卫），headless 16/17 + 1 个 30 s 子进程超时（product headless profile 模型失败冒烟，单跑 20 s 通过；与 alpha.2/alpha.3 记录的同一并发争用瞬态）
git diff --check && git diff --cached --check     # 无空白问题
```

未在本地执行、按 AGENTS.md 交给 CI 或外部验证的证据：全量 `pnpm run test` / `test:coverage`（per-file 100% 覆盖门禁）、assembled Web 快照（`test:web`）、`gateway/admin-project-directory.snapshot.ts`（本机无 `pg`）、Windows 原生通道、真实 DeepSeek API e2e、生产 Gateway 时序。

## 7. 回滚与后续边界

- `events` 兼容 getter 使树外插件在本轮零改动；下一轮若上游继续收紧读取 API，再评估移除该 getter 的时机与迁移公告。
- Gateway 线上头保留 `seedLength`，Gateway schema 与 fork 客户端无需同步发布；存储层与线上层的映射集中在 `session-persistence-gateway`，可独立回滚。
- 持久化 header 形状变化只影响进程内类型与 SQLite / JSONL 的读写映射，不改变磁盘字节（JSONL v0 header 兼容解码、SQLite 列不变）；回滚本 PR 不需要数据转换。
- `web_fetch` 默认开启由 `bundle/base/cordis.patch.yml` 与三个预设的 `fetch: true` 决定，部署可用 overlay 关闭。
- `code-runtime-python` 无 shipped profile 使用，整包替换对默认组合无行为影响；需 CPython ≥ 3.10 的运行环境。
- 独立后续决策点：① #3367 invariant 伴生清理 PR；② 是否采纳 per-record 投影缓存布局（继而可采纳 #3438）；③ #3391 composer 座位归属迁移与 `ui-trajectory` 驻留分页；④ fork 自有 CSS 的整框描边色阶（l4）视觉复查。
- 后续追上游时先重跑 `git diff --no-renames` 与提交清单，再检查本记录「有意不采用」项是否仍成立；三方合并脚本以 alpha.5 为新 base。
