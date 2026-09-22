# Agent Note: 上游 alpha.2 持久层重平台

Status: implemented

[English](2026-09-19-upstream-alpha2-durable-layer-replatform.md) | 中文

## 问题

`dsh-v0.1.6-alpha.2` 对齐的 2B 阶段不是一组互不相干的文件缺口：上游在分叉上次同步（0.1.2-alpha.5 时期）与 alpha.2 之间对 Session 持久层做了整体重平台，剩余全部 2B 缺口最终都汇入这一个原子变更。本地栈端到端早于它：

| 层 | 本地（alpha.5 时期） | 上游 alpha.2 |
|---|---|---|
| `session-format` | `SessionFormatCatalog.migrate`/`createStream`，批量 artifact | codec + `createRestore` 流式行解码、`SessionFormatEventRun` 紧凑 run、`readHeader`/`encodeCurrent*` |
| 代次寻址 | header 元数据内嵌版本（`parseHeaderMeta`、`meta.version`） | 规范文件名 `session.vN.jsonl`、`assertNoRetiredHeaderFields`、取最高代次 |
| `session-persistence-jsonl` | 内联 migrate + verify | `generation.ts` + `storage.ts` + `migration-verifier.ts` + `worker.ts`（worker 线程验证）、multi-edge 发布、内容准入 |
| `session-persistence` | `openHandle`/`openHandleAsync` | `create`/`open(id, access, options)`/`stat`/`list`、`SessionPersistenceNotFoundError`、句柄 `.header`/`.events()` |
| 迁移打包 | `catalog-default.ts` 单体 v0→v4 | 每代 codec+migration 分包，由生成的 `session-format-catalog` 组合 |

脱离核心移植任何叶子都会搁浅：`session-log-export` 的 host archive 本轮移植后回退，因为它依赖上游 `SessionPersistence.open` 句柄 API；jsonl 代次层也直接 import codec 包。

## 决策

整序列一次性采用上游持久层架构，独立的 2B 件本次先落地。

本次落地：

- `compaction` 组同步至 alpha.2：`compaction/summary-error` waterfall 事件（失败摘要的持久输入恢复）、`compactSurfaceRegion` recover/重试循环、`deepFreeze` 迁至 `dsh-llm`、source-event/`CommandDefinitionId` 品牌化、错误文案更新、README 按文档标准重写。
- 新包 `dsh-compaction-image-offload`（required 行）：把 `image/offload` 事件投影到保留消息上，监听 `agent/request-error` 与 `compaction/summary-error` 中的 `IMAGE_OFFLOAD_REQUIRED` 失败，以最旧图片占位符替换后重试。以 `image-offload` 挂载于 `bundle/base/cordis.patch.yml`。
- 新包 `dsh-session-turn-outline`（required 行）：session-projection 缝隙上的 `turnOutline` 投影单元。挂载于 `bundle/web-app/cordis.patch.yml`，登记于 `tsconfig.host.json`。
- `session-format` 补入上游叶子模块 `context.ts`（`SessionFormatEventCollector`）、`filename.ts`（`sessionFormatLogFilename`/`parseSessionFormatLogFilename` 规范 `session[.vN].jsonl` 文件名）、`sessionFormatVersion` 与 `SessionFormatEventRun` 类型。
- 清单修正：六个包移除 stale `zod` 声明，`test-support/client-runtime` 补 `dsh-attachment` devDependency，`compaction-basic` 的 `dsh-util-values` peer/dependency 重复已解。

重平台按序执行：(1) 上游 `session-format` 核心；(2) `session-format-v0-to-v1`/`-v1-to-v2`/`-v2-to-v3` 原样移植；(3) 新建本地 `session-format-v3-to-v4` 包，承载主权 v4 chunk 折叠（`V3ToV4Stage`）加薄封 v4 codec（包装 released v3 codec）——`scripts/gen-session-format-catalog.ts` 已读取 `SESSION_FORMAT_VERSION = 4` 并要求完整相邻链，此包为其必需；(4) `session-format-catalog` + 重新生成 `generated.ts`（v4 restore 钩子与 `message-projections`，`imageOffloadProjection` 现已存在）；(5) `session-persistence` open/handle API 及 jsonl/sqlite/gateway 后端；(6) 消费方（`coordinator`、`llm-replay`、`session-log-export` archive、`core/session`、`session-query`）。

已确认的主权分叉：`session-format/src/surface.ts`（`SESSION_SURFACE_EVENT_TYPES`）保留——与 gateway 持久化共享的本地 wire 表层词汇，上游无等价物。`SESSION_FORMAT_VERSION = 4` 保留——v4 chunk 折叠代是主权代次，alpha.2 止于 v3，catalog 经本地 v3→v4 边包变为 `currentVersion: 4`。`session-log-export` client 面保留本地胶囊菜单设计与 `shell.mobile.header.actions` slot；上游 client 重构随 7A client-runtime 对齐一并到来。

## 备选方案

- **保留批量 catalog 并在其上嫁接 worker 验证。** 否决：上游 `createRestore` 行级解码是内容校验与撕裂尾恢复的入口；混合方案等于重造 restore 层又分叉格式契约。
- **用 `openHandle` 适配 archive.ts。** 否决：上游句柄 API 是持久缝隙的公开契约；把新消费方适配到旧缝隙会在同一版本内制造第二个迁移目标。
- **保留单体 catalog 而不做每代分包。** 否决：生成的 catalog 与 jsonl 代次层直接 import `session-format-v*-to-v*`；单体退役而非维持第二实现。

## 落地形态补充

- 旧批量 API 并未随替换删除：仍依赖 `migrate`/`createStream` 的消费方经由 `legacy-*` 簇（`legacy-types`、`legacy-json`、`legacy-chain`、`legacy-catalog`、`catalog-default`）和公开子路径 `@deepseek-ai/dsh-session-format/legacy` 继续工作，直到逐个迁移到 codec/restore 读取。
- `SessionPersistence` 在保留协调器方法的同时获得上游句柄契约（`create`/`open`/`flush`/`stat`/`list`、`SessionHandle`、`SessionAccess`、上游错误词汇与 `storage-contract` 助手）。旧服务方法 `create`/`list` 与新签名冲突，改名 `createStored`/`listHeaders`；后端 SPI 钩子 `list` 现为 `listStored`。`ContractSessionHandle` 把新句柄适配到协调器原语上——延迟创建、所有权、首次 append 实体化、关闭撤销已与上游语义同构——因此 jsonl、sqlite、gateway 三个后端不做存储重写即通过上游契约套件（各 20 个测试）。`materializeDetached`/`discardDetached`/`listPending`/`isPending` 是适配所需的协调器新动词。
- 上游 live-write 契约（"无写句柄=不落盘"）假定实时写入经句柄路由；本地协调器目前经 `session/event` 自动持久化所有实时会话。该语义随 generation/storage/worker 重平台一并落地，不在适配层内。
- `session-persistence-gateway` 增加 `materializeHeader`（仅 header 的 append）以满足空创建上的句柄 `flush`；测试 transport 将空批次视为实体化写入放行。

## 影响

- 2B 变为一个原子持久层移植加已落地叶子件；消费 Session 读取的下游阶段（session-query documents、llm-replay 语料、快照夹具）在其落地前保持阻塞。
- `session-log-export` archive 随第 6 步进入；本地 client 面（`MobileHeaderAction`、mobile slot）不受影响。
- `scripts/gen-session-format-catalog.ts` 在生成时强制完整相邻链，部分移植会在生成器处失败而非静默漂移。
- 本地 v4 迁移逻辑原样迁入 `session-format-v3-to-v4`；退役单体内的 legacy 归一化由上游 v0→v3 包接替（含同款归一化）。

## 验证

- `vitest run packages/compaction/`：13 文件 247 测试通过（含 image-offload 投影/卸载与摘要恢复覆盖）。
- `vitest run packages/session/session-turn-outline`：2 文件 16 测试通过。
- `verify-cordis-config`：166 文件通过（新挂载可对 manifest 依赖解析）。
- `verify-package-dependencies`：291 包、733 host 边通过。
- 触及包 `tsc -b`：干净。
