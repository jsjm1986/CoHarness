# CoHarness → dsh-v0.2.0-rc.1 升级计划

## 状态、目标与证据

状态：`implementation-in-progress`。本轮目标是让本地 CoHarness 分支在保留既有架构、安全、治理与产品决策的前提下，完成与上游 `dsh-v0.2.0-rc.1` 的全面发布级对齐。0.1.7 全部中间 tag 均为 rc.1 的线性祖先，因此直接以 rc.1 为唯一目标；中间 tag 仅登记在清单 `targetTags` 中，不逐 tag 实施。

| 引用 | 固定值 | 用途 |
| --- | --- | --- |
| 累计比较基线 | `dsh-v0.1.6-alpha.2` / `ddefc45fbc7f8e46dd73185e68295696d1297887` | 本轮累计差异起点；上一轮已实现并验收 |
| 本轮唯一目标 | `dsh-v0.2.0-rc.1` / `4878cdabd87d4041bdaff61d04c966883b9fd07a` | 未实施部分直接采用此树的最终实现 |
| 中间 tag | `dsh-v0.1.7-alpha.1` `c36a83ff` 、`dsh-v0.1.7-alpha.2` `00102833` 、`dsh-v0.1.7-rc.1` `46a7f68b` 、`dsh-v0.1.7-rc.2` `477b4f42` | 仅作清单登记与历史参照，不单独验收 |
| 本轮实施基线 | `ceb9acb9e7e7911301516900948eb9635218aec1` / `fix/session-log-confirm` | 新候选必须取得自己的验证证据 |
| 发布版本 | 暂拟 `0.2.0-rc.1.coharness.1` | release families 与生产版本核验后确定 |

[清单](../manifests/UPGRADE-MANIFEST-dsh-v0.2.0-rc.1.json)记录决定与阶段；[矩阵](../alignment/UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.2.0-rc.1.json)记录 7106 个累计差异路径的 359 个唯一 area、30 条 gate replay 复审；[提交清单](../alignment/UPSTREAM-COMMIT-INVENTORY-dsh-v0.2.0-rc.1.json)把 1252 个非合并提交按主权分桶（702 carried、1 newUpstream 幽灵包、192 upstreamOnly、3 owned、354 none）；[本轮审计](../alignment/UPSTREAM-AUDIT-dsh-v0.2.0-rc.1.md)、[Host 修复审计](../alignment/UPSTREAM-FIX-AUDIT-HOST-dsh-v0.2.0-rc.1.md)（123/123）与[客户端修复审计](../alignment/UPSTREAM-FIX-AUDIT-CLIENT-dsh-v0.2.0-rc.1.md)（454/454）合计 577/577 条修复提交逐条登记处置与本地落点。[同步记录](../../scripts/upstream-sync.json)已固定 rc.1 源码比较目标；主权门禁输出为 46 tracked、221 adapted、35 owned（含 1 个 `upstreamShadowed`）、2 replaced、46 upstreamOnly。

## 审计方法与交叉验证

本轮审计用不超过 5 路并行 subagent 做互相覆盖的核查，并人工复核了全部争议结论：包级完整性（316 上游 / 304 本地逐包处置）、排除面反向依赖、持久化/线协议语义、以及全部 fix 提交的意图级分类。一次被污染的 durable-format 报告被整体作废，其声明仅在被本地与上游树逐条实锤后采信。矩阵生成器 `scripts/gen-upstream-alignment-matrix.ts` 与 `scripts/gen-upstream-commit-inventory.ts` 使台账可再生；主权门禁扩展 `upstreamShadowed` 表达同名遮蔽包。

审计修正了初始计划的实质缺口：`util/code-language`、`util/workspace-path` 从排除翻转为必须采纳；`client/store` 不携带而以导入重映射落到 `client/runtime`；rc.1 新增 `configForms` 注入缝（17 个 client 包硬注入）按 P6 逐包改写吸收；vendor Cordis 缺 `Volatile`/`VolatileSnapshot` 成为编译期阻塞，P1 必须先做三向合并；`agent-team-web-profile` 跟随上游折叠删除；`session/session-format-v3-to-v4` 是同名遮蔽，`developer/message`、`forked` 与上游 V4 事件词汇经 v6→v7 相邻迁移边逐事件吸收。

## 已锁定的实施决策

| 决策 | 结论 | 不可放宽的条件 |
| --- | --- | --- |
| Session 客户端类型面 | 逐包改写到 `client/runtime` | 不新增 `api/session-controller` 适配层，不引入第二份客户端会话状态源 |
| `configForms` | 逐包改写注入 | 不建兼容服务；每个吸收的包直接改写为 `settingsScope` 注入，保留治理与 revision fencing |
| Jobs | 采纳上游环形输出重写，`JobView` 远程面并入 `host/apiproxy` | `JobChunk`/lossy/`spillPath`/`owner: SessionId` 语义采纳；不新增独立 `api/job-controller`；独立里程碑验收 durable、线协议、完成上报、有界读与多运行时隔离 |
| `apps/cli` | 全量提交意图审计 | 与 `apps/web` 同标准；不因 Web 为主产品而冻结或只做 merge-clean |
| Bash justification | 保我方更严 | 非空 justification 要求保留，记录为显式分叉 |
| Job 唤醒上限 | `maxConsecutiveWakes` 3→10 | 有界折中，不做无界；保留多租户保护 |
| 开发者工具默认开关 | 保持默认关 | 不移植上游默认开；记录为产品策略分叉 |
| XLSX 预览 | 引入 Fortune Sheet | 接受重依赖与补丁维护成本；office-to-PDF 继续覆盖其他 Office 类型 |

## 范围和变更纪律

产品定位不变：以 Web UI 为主的云端多租户产品，`host/apiproxy` 是唯一 BFF 与远程分发面，`client/runtime` 是唯一客户端会话状态源，settings 治理与 session v6 格式为我方主权。上游桌面双 app、账号链、产品遥测、语音链、快捷键不携带（矩阵 reject 行与 manifest `exclusion-ledger` 决策登记）；上游新增 `telemetry/otel` 不携带，保留自包含 `session-telemetry-otel` 并只移植其字节有界批处理。排除不等于不审查：被排除包内夹带的共享面修复仍按 fix 审计逐条核对到本地方。

Session JSONL 代次不可变，新增语义走相邻迁移；SQLite `SCHEMA_VERSION` 单调；上游 V4 同名包不文件级归并。公共 API 变化必须更新全部消费者；session/loop/event 变化同步更新 TS 与 Python SDK。生产 bundle 的 `maxInlineBytes`→`maxInlineTokens` 迁移与 `protocol` 配置键移除必须与对应代码改动同批落地。每相位独立可验证、独立成 PR；提交、推送、PR 与合并由用户处理。

## 阶段、依赖与放行条件

关键路径为 P0→P1→P2–P5→P6→P7→P8→P9；P2–P5 之间按依赖局部并行，P7 的 apps/web 意图审计以 fix 审计清单为输入可在 P6 侧包完成后滚动进行。

| 阶段 | 前置 | 范围 | 必须提供的证据 |
| --- | --- | --- | --- |
| P0 台账 | 无 | `upstream-sync.json` bump、遮蔽 schema、矩阵/清单/计划/审计入库、30 条 gate replay 复审 | 主权门禁与升级记录门禁通过；359 行精确划分 7106 路径；702 carried 提交全部有行认领 |
| P1 编译地基 | P0 | vendor Cordis/cosmokit 三向合并（`Volatile`/`VolatileSnapshot`）、本地 vendor 补丁重放或退役、carry-in 包（`llm-deepseek-api-key`、`agent-preset`、`agent-preset-registry`、`code-language`、`workspace-path`、`remote-mock`、`tool-workspace-dependencies`）、tsconfig/lockfile、新门禁（module-graph、scoped-events、client-packages、cordis-config、constraints） | `pnpm run test && pnpm run build`（vendor 惯例）、typecheck、新门禁可执行并对当前树给出判定 |
| P2 merge-clean | P1 | sandbox（含 Windows ACL 强化）、lsp、storage、ssh、compaction、spill、guard、fs 及其余 46 个逐字节一致 tracked 包整包替换；adapted 包逐文件归并 | 46 retain 行全绿；每包 focused tests；spill 写失败不杀进程、atomic-write 陈旧锁接管等 host 审计 port 项落位 |
| P3 llm | P1 | `llm-deepseek` 库化 + `llm-deepseek-api-key` 路由拆分、删除 chat-completions 与 `protocol` 键迁移、生产 bundle 行同批改、`pi-ai` 补丁登记（含流式参数 O(n²) 修复）、retry/token-meter | 双协议快照、生产 bundle 核验、真实 provider e2e；`llm-deepseek-account` 保持 upstreamOnly |
| P4 session/core | P1、P2 中相关包 | agent-loop 旗舰优化（KV-cache 保活、动态工具、tool-schedule 恢复、ToolCallRecovery、abort-cause 归一化、失败步骤 pending tool call 收口）、v6→v7 事件边（developer/message、forked、tool-role 流式、attachments、`plugin:<name>`）、jobs 环形重写进 apiproxy、schedule durable kinds（daily/weekly/cron）、persistence 身份/缓存、`maxInlineTokens` 迁移 | 相邻迁移与不可变代次测试、取消/失败/恢复用例、SDK 双方快照、多运行时 job 隔离与有界读、生产 yml 同批改 |
| P5 组合层 | P3、P4 接口稳定 | plugin-manager +3281 行（保 `authorization`/`protectedModules` 注入与 NDJSON 白名单）、app-boot/hmr、bundles 剪账号行（保语义撞车的 `dsh-settings-file` 行）、`api/remotes` 重写、settings 选择性吸收、preset 双包重写（保 `derivePatches`/realm/remote 契约） | 授权负例、远程契约测试、bundle 组装快照、preset 五处消费者重接线证据 |
| P6 client web | P5 | 采纳包逐包改写注入到 `client/runtime`/`settingsScope`；右栏预览栈、queue/deliverables/反馈/连接态/密度/ui-tool 渲染/agent-team UI/ui-primitives 挑拣、五个 ui-settings 区、Fortune Sheet XLSX | 每包注入点改写无残留 `configForms`/`dsh-client-store` 引用；UI 行为变化有真实服务端+模型流 GIF；blank-session writer 竞态等 client 审计 port 项落位 |
| P7 apps | P6 | `apps/web` 184 fix 意图级逐条（reproduce-or-refute）+ 功能吸收；`apps/cli` 全量意图审计；`apps/android-shell` 本地车道核对 | 每条 fix commit 有处置记录；新会话陈旧 blank 缓存回归、tooltip 顶层断言、e2e Office runtime 预备战备经回放移植 |
| P8 experimental | P4、P5 | agent-team 全链（含 web-profile 折叠）、computer-use 与新 shim、mcp、acp、subagent、ptc | 对应能力测试与组装快照；折叠删除无残留引用 |
| P9 收口 | 全部拟发布项 | TS/Python SDK 同步、catalog/doc 重生、快照重录、全门禁、生产部署 + 全业务冒烟（Web UI 真实路径：用户/管理 UI、数据库、网关、会话、工作区、模型路由、SSH、配额、备份） | 每个矩阵行以目标版本复核结果与消费者证据收口；真实环境冒烟记录；不得把本地单测当作生产或浏览器验证 |

## 风险单列

- **`api/remotes` 剪枝瓶颈**：rc.1 client index 硬导入约 20 个远程面，先于各包合并重写，否则吸收包连锁缺注入。
- **V4 词汇兼容**：`plugin:<name>` source kind 与 attachment-link 改动会改变日志长相，必须进 v6→v7 逐事件核对，不得改已发布代次。
- **settings 行语义撞车**：rc.1 `settings` bundle 行与我方行同 id 不同服务身份，合并时保本地行。
- **幽灵包**：`util/ip-geolocation` 在区间内先建后删，矩阵以显式行登记其提交，避免台账漏账。

## P1 执行记录

已落位：vendor 三向合并完成（`Volatile`/`VolatileSnapshot` 引入 cordis/cosmokit/schemastery/loader，上游 volatile 测试 43 项通过）；carry-in 干净叶子包 `util/code-language`、`util/workspace-path`、`skill/tool-workspace-dependencies`（228 测试通过）；`patches/@earendil-works__pi-ai@0.85.1`（流式参数 O(n²) 修复）与 libreoffice-kit 0.1.1 + `libreoffice-packages.mjs` 模块改写；`verify-no-unknown-casts` 门禁（基线 2037 条）；`verify-package-paths` + `repo-files.ts` + `historical-schema-region.ts` 回归修复（基线导入时丢失的历史 schema 区间豁免机制恢复，spec 20 项通过）；`test-dom-environment.ts` 接入三个 setupFiles；apps 测试 glob 补 `.tsx`；`micromark-util-types` 经 dedupe 收敛至 2.0.3。

延后到相位（依赖未落地的车道工件）：`remote-mock` → P6（需要 `ClientConnectionRpc`/`isRemoteUplinkItem`）；`llm-deepseek-api-key` → P3（需要 deepseek 拆分产物 `deepSeekConfigFields`/`Volatile` 配置）；`agent-preset`/`agent-preset-registry` + `optional-bundles.spec.ts` + `verify-package-meta` + `gen-plugin-packages` → P5（需要 `app-boot/package-meta.ts` 与 `SettingsProvider.configure`）；`persistence-schema-snapshot.spec.ts` → P4（persistence-schema-model 上游重写）；`verify-client-route-resolution` → P6；`verify-v3-event-vocabulary` → P4/P9（需要遮蔽包 `session-format-v3-to-v4` 提供 `RELEASED_V3_EVENT_TYPES` 或改写 pin）；`merge-translation-pairing`/`translation-pairing-merge` 删除与 `gen-cordis-catalog-record.spec.ts` 孤儿处置 → P9。

P2 收尾新增顺延：`compaction-basic/src/summarizer.ts` 的 `toolHistory` 实参与 `test-support/llm-replay` 的 `toolUpdate` 路由字段 → P3（依赖上游 `ToolUpdate`/`projectToolUpdates`/`GenerateOptions.toolHistory` llm 面）；`session-snapshot/tests/fixtures/dynamic-tool-{updates,prompt-updates}.ts` 两个 fixture → P3（同上）；`skill-office/tests/xlsx-validation.e2e.ts` → P3/P4（依赖上游 `ToolResultMessage` 重写：`role:'tool'` + 消息级 `toolCallId`/`isError`）；shell 工具 spec 的上游断言面（`readAt`/`processSources`/`ringDelta`/`TerminalWaitReason`/`promptTailGraceMs`）→ P4（jobs 环形重写车道）；`schedule` 服务 seam 行从 doc-graphs 角色表移除（我方是 Session-fold 插件模型而非上游 Host-domain 服务）→ P-未定，若采纳上游 Host-domain 重写需回插。

本相位发现的本地回归（已修）：`scripts/verify-package-paths.ts`、`scripts/repo-files.ts`、`scripts/historical-schema-region.ts` 在基线导入时丢失 `excludedRange` 机制，已由 rc.1 版本恢复（保留本地额外扫描 `examples/**/*.ts`）。
