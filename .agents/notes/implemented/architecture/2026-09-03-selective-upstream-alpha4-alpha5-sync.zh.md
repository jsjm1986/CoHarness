# Agent Note: 有选择地整合上游 alpha.4 与 alpha.5

Status: implemented

[English](2026-09-03-selective-upstream-alpha4-alpha5-sync.md) | 中文

## Problem

上游 `dsh-v0.1.2-alpha.4` 改的是会话协议本身，而不是在旁边加功能：`Session.events` 变成按需读取 API，`SessionSeq` 与 `SessionLogOffset` 品牌贯通整条 session 栈，持久化 header 用 `{ meta.isSeeded, inheritedEventCount }` 取代 `seedLength`，单向 `report` 工具被双向 `send_message` steer 服务取代。`dsh-v0.1.2-alpha.5` 只加了一个针对上游 per-record 投影缓存布局的升级路径修复。CoHarness 与这些 tag 没有共同 Git 祖先，并且自有 ApiProxy history wire、Gateway 与 SQLite 持久化后端、UI façade，以及读取 `session.events` 的树外插件。按 release note 逐条手工挑选无法把协议变更贯通到 fork 自有包，整树文本合并又会覆盖这些所有者。

## Decision

fork 用文件级三方合并整合两个 tag（`git merge-file`，base 为上游 alpha.3 版本、ours 为 fork 版本、theirs 为上游 alpha.5 版本），对 245 个冲突文件逐块裁决；上游从未触及的 fork 自有包按 `typecheck` 报错逐点适配直到清零。完整矩阵见 [`UPGRADE-PLAN-dsh-v0.1.2-alpha.4-alpha.5.md`](../../../../UPGRADE-PLAN-dsh-v0.1.2-alpha.4-alpha.5.md)；机器可读清单是 [`UPGRADE-MANIFEST-dsh-v0.1.2-alpha.4-alpha.5.json`](../../../../UPGRADE-MANIFEST-dsh-v0.1.2-alpha.4-alpha.5.json)。

已交付代码采纳以下上游行为：

- `Session` 暴露 `seq`、`eventAt()`、`snapshotEvents()`、`ownEvents()`、`isOwnSeq()` 并复用不可变快照。`@deprecated get events()` 返回缓存快照，树外插件零成本继续编译运行；fork 自有调用点迁移到 `snapshotEvents()`。
- `SessionSeq` 与 `SessionLogOffset` 品牌贯通 `dsh-session`、包括 fork SQLite 与 Gateway 提供者在内的全部持久化后端、投影与投影缓存、标题、子代理、agent loop、token meter、goal、schedule、ApiProxy history wire 与 SQLite 迁移脚本。`dsh-brand` 只新增 `BrandedNumber<B>` 类型；fork 保留 cast 工厂而不引入上游运行时 `brandNumber`/`brandString`。客户端 `ConversationNode.seq` 与上游客户端一致保持 plain number。
- 存储元数据为 `{ meta: { isSeeded }, inheritedEventCount }`。JSONL 兼容解码 v0 的 `seedLength` header 字节，SQLite 映射 `seed_length` 列，Gateway 线上头保留 `seedLength`（Gateway schema 是权威）；`session-persistence-gateway` 拥有 `GatewayWireHeader`/`wireHeader()`/`storageFrom()` 映射。
- 删除 `report` 工具及其包。`tool-subagent-control` 新增以 `agent_id` 定位、按 steer 语义投递的 `send_message`，`dsh-subagent` 从 `./internal` 导出 `queueHostSubagentPrompt`，`host/apiproxy` 与 `experimental/agent-team` 经它入队浏览器与团队 prompt。上游 Remote `control.ts` 继续不用。
- 模型发现在 `LlmEndpointModelDiscoveryRequest` 上接受 profile `headers`，`llm-pi-ai` 携带 `StoredModelDiscoveryProfile { headers, resolveApiKey }`，模型目录 picker 可搜索。
- `bundle/base` 挂载 `web-fetch-http` 并开启 `web_fetch`；fork 三个预设（`code`、`cordis`、`standard`）设 `tool-web.fetch: true`，`code` 预设关闭 `workflow` 工具但保留引擎。2026-08-29 对 `web-fetch-http` 的公网地址 pinning 使该默认值在 fork 的多用户 Gateway 部署中安全。
- `ui-theme` 新增 `corner-shape.css`、`gradient-shadow-text.css` 与 per-element elevation token。上游样式守卫套用到 fork 自有 CSS：`0.5px` hairline 描边、悬浮面不用中性边框、全圆角元素加 `corner-shape: round`。轮次导航预览层位于代码 banner 之上。
- 长会话渲染工作中，`buildLocationData(context, scope, previous)` 复用相同的 Location 值，`flush()` 报告是否有 view 被重新发布，`ui-slots`/`ui-renderer` 新增 inject `keyedHooks` 隔间，`InputBar` 做 memo，产出文件芯片用 CSS 布局。
- `code-runtime-python` 整包替换为 `packages/experimental/code-runtime-python` 的上游 experimental 包，适配 fork 导入（`snapshotJsonValue` 来自 `dsh-session`）、保持 `private`、补 fork 的 `./invariant` 伴生。需要 CPython 3.10 或更新。
- 修复 alpha.2/alpha.3 同步引入的两处 fork 回归：`loadLiveSnapshot` 的 `!state.materialized` 守卫，以及 `list-children` 的 seq gate 与 `origin`/`agentPreset` 生命周期见证键。

代码有意保留以下 CoHarness 决定：

- 不采纳 per-record 投影缓存布局，因而不采纳 alpha.5 的 `compatibleVersions`/`invalidRecords`/`backupRecord` 修复；fork 的整介质 version 3 缓存保留。缓存身份采纳可选 lineage 字段（`isSeeded`、`inheritedEventCount`）且不升 medium 版本，未 seeded 会话的既有行继续可读、seeded 会话自动重折，在 fork 架构内覆盖同一升级风险。
- invariant 伴生清理（#3367）拆到独立 PR；包括新 experimental Python 包在内的每个包都保留 `./invariant` 导出。
- 不采纳 `ui-trajectory` 驻留分页、composer 座位归属迁移（`conversation.input.*`/`conversation.composer.dock` 挂到 `composer.bar` 下并去掉 `owner: InputZone`）以及 `ChatNodeStore` 的 per-node observable source；fork 保留服务端历史窗口、三座位 `InputBar` 与插件可见的 slot 归属。
- 上游共享工具包（`dsh-util-values`、`dsh-util-time`）、Remote controller、`RemoteError`、focused `ui-chat`/`ui-session` 包继续不采纳；导入映射到 `dsh-session` 与 `dsh-llm` 的等价物。
- fork 有意删除的行为对应的上游测试（route pricing、request `series`、turn rail、registry `hydrate`、`titleInput`、运行时品牌）不回收。
- DSH 发布族为 `dsh-v0.1.2-alpha.5` 代码基线携带 `0.1.2-alpha.5.coharness.1`，tag 为 `dsh-v0.1.2-alpha.5.coharness.1`；`apps/android-shell`、vendored 与 native 发布族保持各自版本线。

## Verification

`typecheck`、`lint`、`doc-sync`（28 个叶子）、`hygiene` 与 `release:verify --family dsh`（247 个成员统一为 `0.1.2-alpha.5.coharness.1`）在源码与产物平面通过。对 115 个含源码或测试改动的包目录做聚焦 Vitest，604 个文件、10186 个测试通过；experimental Python 运行时在 CPython 3.12 下 283 个测试通过、2 个跳过。11 个目录与图生成器全部 exit 0 且其经审校的中文对应稿已同步移植，翻译配对记录 1162 对一致，keyless ACP 套件在 `send_message` schema 刷新后 93/93 场景回放通过；`subagent-continuable` transcript 重新编排，使子会话的两条消息覆盖 Steer 的两条路径（已结算的子会话冷恢复进自己的新轮次、运行中的子会话在 step 边界领取下一条消息），失败的持久性检查点仍以父级自己的后续轮次结算。headless 套件在并发 5 下回放 16/17，产品 profile 的模型失败冒烟串行运行时在 30 秒子进程期限内通过。根目录计划记录了精确命令。Windows 原生通道、真实 DeepSeek API 调用、组装浏览器快照、依赖 `pg` 的 Gateway 快照和生产 Gateway 时序仍是外部证据。

## Alternatives considered

**像 alpha.2/alpha.3 那样按 release note 手工移植。** 否决：alpha.4 的改动是协议级的，品牌、存储元数据与读取 API 触及数百个文件，手工移植会让 fork 自有后端留在旧类型上。三方合并带入每一个上游 hunk，只把真正重叠处留给人裁决。

**像上游一样删除 `Session.events`。** 否决：仓库之外的 `dsh-model-governance`、`dsh-directory-guard` 与 Gateway 代码在读它。基于缓存快照的 `@deprecated` getter 零成本，并给这些消费者迁移窗口。

**把 Gateway 线上头改为 `isSeeded`/`inheritedEventCount`。** 否决：Gateway schema 是权威且独立发布；在持久化提供者处映射让线上稳定，并把改动限制在一个包内。

**采纳 per-record 投影缓存布局以吃下 alpha.5 修复。** 本轮否决：fork 从未采纳 per-record 存储，lineage 字段可选后整介质布局没有跨版本读风险。是否采纳仍是独立决策。

**在同一 PR 里删 invariant 伴生。** 否决：#3367 触及约 1400 个文件却无产品变化，且与覆盖率 worktree 重叠；拆分 PR 让本次同步可审。

**继续关闭 `web_fetch`。** 否决：原因（多用户部署中未 pinning 的 fetch provider）已被 2026-08-29 的公网地址 pinning 消除，且上游预设自 alpha.1 起就开启 fetch。

**采纳 `ui-trajectory` 驻留分页与 composer 座位迁移。** 否决：fork 已有服务端历史窗口与自有虚拟化，`owner: InputZone` 是插件可见契约；一旦 `InputBar` 必须订阅整个会话快照，座位迁移的 memo 收益就消失。

## Consequences

fork 现在端到端使用 alpha.5 会话协议，包括经过自有持久化后端与 history wire，而磁盘字节、Gateway 线上、授权与 UI 组合保持不变。未来上游 tag 可用同一套三方合并流程以 alpha.5 为 base 合入。维护的差异在三个有名字的地方增长：deprecated `events` getter、Gateway `seedLength` 映射、整介质投影缓存；每一项都在计划中记为未来决策点。
