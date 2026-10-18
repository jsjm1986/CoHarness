# CoHarness → dsh-v0.2.1-rc.2 升级计划

## 状态、目标与证据

状态：`implementation-in-progress`(主体迁移已完成并逐批落地;收尾缺口按 defer 决策行登记)。本轮目标:在保留既有架构、安全、治理与产品决策的前提下,完成与上游 `dsh-v0.2.1-rc.2` 的发布级对齐。0.2.1 全部中间 tag(alpha.1–alpha.5、rc.1)均为 rc.2 的线性祖先,直接以 rc.2 为唯一目标;中间 tag 仅登记在清单 `targetTags` 中。

本地 `afc4bf40751` 的[独立复核报告](../alignment/UPSTREAM-AUDIT-dsh-v0.2.1-rc.2.md)记录了已复现的发布阻断、生命周期问题及历史欠账;后续收口须逐项补齐报告中的实现与验收证据。[证据附件](../alignment/UPSTREAM-AUDIT-dsh-v0.2.1-rc.2.json)保留官方发布说明原文和本次执行记录。

| 引用 | 固定值 | 用途 |
| --- | --- | --- |
| 累计比较基线 | `dsh-v0.2.0-rc.1` / `4878cdabd87d4041bdaff61d04c966883b9fd07a` | 本轮累计差异起点;上一轮已实现并验收 |
| 本轮唯一目标 | `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317` | 未实施部分直接采用此树的最终实现 |
| 本轮实施基线 | `8cb2cf1d3459d6fb121915c6b2e3375eef684af9` / `feat/upstream-sync-batch2` | 新候选必须取得自己的验证证据 |
| 发布版本 | 暂拟 `0.2.1-rc.2.coharness.1` | release families 与生产版本核验后确定 |

[清单](../manifests/UPGRADE-MANIFEST-dsh-v0.2.1-rc.2.json)记录决定与阶段;[矩阵](../alignment/UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.2.1-rc.2.json)记录 9323 个累计差异路径的 395 个唯一 area、30 条 gate replay 复审;[发行说明台账](../alignment/UPSTREAM-RELEASE-NOTES-LEDGER-dsh-v0.2.1-rc.1.md)登记 rc.1/rc.2 逐条裁决。[同步记录](../../scripts/upstream-sync.json)已固定 rc.2 源码比较目标(`syncedTag: dsh-v0.2.1-rc.2` / `687f282e`);当前主权门禁输出为 72 tracked、225 adapted、46 owned(含 1 个 `upstreamShadowed`)、2 replaced、42 upstreamOnly。

## 已锁定的实施决策(已落地)

| 决策 | 落点 | 不可放宽的条件 |
| --- | --- | --- |
| preset 双包迁移 | `8a6aa525882` | `agent-presets`→`agent-preset`+`agent-preset-registry`;声明式注册层叠在 fork 文件发现/authoring/inventory 核心之上;`agent-presets` settings 命名空间不变(持久化用户键);declared preset 无 `path`,`FileAgentPreset` 收窄纯文件操作 |
| 运行时不变量移除 | `b569ce4f87e` | 跟随上游 `f028f25667d`:44 个 `src/invariant.ts` 伴生与全部 verify 门禁拆除;补偿性 spec 按上游 `96371534` 范式保留 |
| subagent catalog 外部执行 | `c73e7e911de` | 版本化叶条目;不迁统一激活面;外部可续接 Team 成员为 fork 独有能力 |
| remote-access 概念移植 | `95e354ad9ef` | 概念并入 `collaboration.authorize` 接缝;不做 controller 拆分;`api/remote-access` 记 upstreamOnly |
| ssh-helper-runtime | `079462b5208` | `kind:'node-script'|'embedded'` 判别联合 + pkg SEA;远端免 Node 收窄已记录 |
| DeepSeek Search/Fetch API | `a410ac34995` | `web/web-deepseek-api` 移植 + 实时 provider 开关 |
| claude-code-mods 抽取 | `10cff3fb193` | `dsh-client-store`→`dsh-client-runtime/client` 重映射;同族 11 个 experimental 包按命名阻塞项 defer(见抽取 note) |
| upgrade-guide 裁决 | `cb4fc43d05b` | 五篇上游指南不发布:对应行为未携带,指南只能描述已承载行为 |

## 阶段执行与放行条件

| 阶段 | 范围 | 状态与证据 |
| --- | --- | --- |
| E1–E8a | DeepSeek Search/Fetch、client 面、workspace/settings 对齐、remote-access 概念 | 已落地并逐批提交 |
| E9 | 运行时不变量移除 | `b569ce4f87e`;host/client 聚合构建全绿,140 门通过 |
| E10 | preset P5 双包迁移 | `8a6aa525882`;registry 181 tests + declared spec 7 tests 全绿 |
| E11 | upgrade-guide 裁决回填 | `cb4fc43d05b`;五篇不适用指南裁决登记 |
| E12 | 台账收口 | rc.2 矩阵生成(395 行/9323 路径/30 replay 复审);`syncedTag` 推进;主权门禁与升级记录门禁全绿 |
| E13 | 独立复核修复批 | 见下节：审计发现的发布阻断/生命周期/记录欠账逐项修复;五项历史默认值经 owner 裁决落地;alpha.1–alpha.4 未发布指南处置(15 回填/14 登记);七项上游行为经裁决移植 |

## 收尾缺口(收口结果)

1. `schedule/tool-schedule` 声明入 preset — **已落地** `3bd8b04bf09`:模型面四工具拆为 `dsh-tool-schedule` Consumer,standard/cordis/ptc preset 声明于 tool-jobs 后,schedule-bundle 仍为 Host 服务 opt-in。
2. python 主运行时 alias 校验 — **已落地** `9f835754a02`:`primaryRuntimePythonAliases`/`copyPrimaryRuntime` + smoke 拒绝展开命令文件。
3. bundled NumPy/pandas 测试套件剔除 — **已落地** `9f835754a02`:`prunePrimaryRuntimePythonTests` 在 wheel 解包后剔除 `tests/` 目录并重写 RECORD;payload digest format→7。
4. subpath plugin display-manifest 语义深度核对 — **已承载**:`app-boot/package-meta.ts` 与上游逐字节一致(仅 package-root 读 package.json,subpath 仅靠 `<specifier>/icon`),spec 100 测覆盖;指南三件套已回填。
5. `ui-plugin-market` policy/violation 复查 — **通过**:parse/index-url/types/search/tools/worker/parse-thread 与 `util/plugin-market-index` 全部与上游逐字节一致,后续上游修复(源码仓字段、Installed tab、generator commander)均已吸收;仅余刻意分歧——settings 命名空间 `SettingsScope`(fork settings 治理)、`bundle.optional`(fork optional-bundle 模型)、自有图标命名、`dsh-client-runtime` store 导入。`client/ui-secret-mask` **维持 defer**:依赖上游拆分版 `ui-conversation` 的 UserText rule lane,fork 刻意保留整合版 conversation(`removedUpstreamPaths` 已登记);本轮无 GUI 可见变更,GIF/PR 不触发。

## 复核修复批次(E13)

独立复核(见[审计报告](../alignment/UPSTREAM-AUDIT-dsh-v0.2.1-rc.2.md))暴露的缺陷与欠账已逐批修复,全部修复以失败优先测试与真实 Loader 组合回放验证:

- **数据与生命周期**:JSONL 卸载丢失末事件(含 `__proto__` 键)、凭据 watcher 关闭期迟到错误、预设切换并发竞态、任务停止失败悬挂、侧栏世代所有权、打开应用失败覆盖、浏览器恢复同意、Review 页原生打开、披露重置代际、turn-trigger 分类+尾锚、分组渲染、ChatView 可见行锚点(有界二分)。
- **原生产物(macOS arm64)**:exe/ssh-helper/wheels 构建验证;SEA glob 漏无前缀 `@deepseek-ai/dsh` 致 icon 未进 blob(ENOENT)已修;office/node fixture 断言归位;`tool-history.json` 与真实 exe 逐字节一致。**Linux/Windows 未重建验证,不据此外推。**
- **快照与回放**:ACP 94/94(根因=`b569ce4f87e` 误删金样空行,代码与上游输出一致);合并 Web 快照 50 份按归因重录、孤根 `snapshots/web/background-job-list/` 孤儿金样删除;4 份陈旧 SDK 场景逐 diff 归因后重录。
- **门禁债务**:knip 清零、duplication 归位(ui-workbench `contract/` 共享层)、54 处新 `as unknown` 全部改为真实类型(其中 7 处伪装断言返工),verify-no-unknown-casts 以精确指纹基线通过;rescope-vendor、doc-sync 41/41、hygiene 21/21 全绿。
- **owner 裁决落地**:web minimal 仅持久 Shell(编辑器显式启用)、Ralph 默认关(可显式 opt-in)、显式空白 justification 一律拒绝(bash+pwsh 对称)、`maxConsecutiveWakes` 维持 unset=不限、凭据 env-first 维持。
- **指南处置**:34 篇中 29 篇此前未发布——15 篇回填发布(5 篇按 fork 实况改写),14 篇登记不发布(排除面/未携带/已裁决);裁决与代码证据见审计报告指南处置节。
- **本轮移植裁决项**:`plugin-option-placement`(--profile 仅前置)、`session-title` 两篇(prepareCall 适配器+provider 策略重写)、`pi-ai-model-discovery`(缺凭据返回空目录)、`new-session-generations`(新建必新,重连仍复用)、`operator-connect`(经 fork 自有接缝:启动令牌接入+连接级 interactions 模式+claimInteraction 认领,不移植上游 Peer/Cookie/$events 机制)、`job-id-identity`(<kind>-<16hex>)。pwsh 重复模式对齐 fork bash(有意对称,上游无此豁免)。

**诚实边界**:矩阵 395 行 cumulative source review 已全部复核翻篇(not-carried 尾部按类归因登记,未吸收的具名上游增量在各行 notes 登记待后续 increment 裁决);真实 provider 调用、Windows/Linux 原生矩阵、双用户部署、生产备份恢复仍未执行;GUI 变更的 GIF 归 PR 提交环节。

## 范围和变更纪律

沿用 rc.1 计划的产品定位与纪律:`host/apiproxy` 唯一 BFF、`client/runtime` 唯一客户端会话状态源、settings 治理与 session v6 格式为主权;Session JSONL 代次不可变;SQLite `SCHEMA_VERSION` 单调;公共 API 变化同步全部消费者与双 SDK;上游桌面/账号/遥测/语音车道继续不携带。排除不等于不审查:被排除包内夹带的共享面修复仍须核对到本地方。

## 风险单列

- `experimental/` 迁位:上游 rc.2 将 10 个包移入 `experimental/`(hook-protocol、hooks-claude-code、hooks-codex、tool-terminal、tool-ralph、tool-session-query、session-title-all-prompts-llm、skill-badge、webhook、webhook-github);fork 保留自身分组路径,经 `upstreamOnly.replacedBy` 反向映射,不追随路径改名——下次同步须复核映射无漂移。
- 主权翻转:8 个原记 `owned` 的包经核证为上游同源移植(plugin-market 四件、harness-dev-context、web-deepseek-api、working-directory 两件),已改 `adapted`;`session-format-v3-to-v4` 维持 owned+`upstreamShadowed`。
- 上游同键包扩散：除已遮蔽两包外，新增包再撞 fork-owned 名时需同样走 upstreamShadowed 流程。
- CI 演进与本地门禁脚本交互（parallelism/coverage 改造影响 run-gates.spec 断言面），P1 需重跑受影响 spec。
- hooks/webhook 降级若不跟随，需保持原位包持续通过主权门；若跟随，bundle/文档双侧同步改名。

## P0 执行记录

- 2026-10-19：清单 1,622 commit / 矩阵 395 行 / 30 gate replay（23 条变更逐条复核登记）/ 审计与 manifest 落地 / `verify-upgrade-records` 通过（21 份记录）。

## P1 执行记录

已完成（cherry-pick 至 `feat/upstream-sync-batch2`）：

- `a6d2a03`：`engines.dsh` 兼容性检查（上游 `plugin-compatibility.ts` 直取）+ `peers`→`requirements` 改名传遍 plugin-manager 类型/操作/失败映射、web 与 gateway admin-ui 渲染及双语文案、api-catalog 重生成。
- `1ff3fb8`：cordis publish 版本 4.0.4→4.0.5（rc.2 窗口内 vendor 唯一变更，src 零差）。
- `334feeb`：`scripts/parallelism.ts` 直取（LOCAL_PARALLELISM_CAP=12 / TEST=48，CI 用全核）+ run-oxlint 归并（cpus 参数、本地预算绑定、调用方 `--threads` 透传；保留我方 CI=1 拼写与 fix/unused-disable 道）+ `actions/cache`→v6.1.0 批量 pin + benchmark timeout 15→20m。
- `81484f4`：`release/publish.ts`、`publish-npm-baseline.ts` 直取（dist-tag 校验 + 通道核验；我方 `packFilters` 死代码冲突块按上游删除，静态目录 glob 覆盖同一集合）；根 devDeps 加 `semver@^7.8.5`/`@types/semver@^7.8.0`，pnpm→11.28.5、smol-toml→^1.9.0；pyproject 吸收 Pillow==12.3.0 + core-metadata 2.4（ruff 保留——我方 ci.yml 仍跑 quality 组；license 保 Apache-2.0 不回退 MIT）。
- `651c4da`：timeout 注入路径切换为上游语义——`coverageTestTimeoutOptions`/`parseCoverageTestTimeout` 进 config 内联 project（CLI 不转发 hookTimeout/poll），`coverageTestTimeoutArgs` 及其三个调用点（run-gates 双道、run-coverage-partitions）移除；vitest 根道挂 `localWorkerBudget`（本地 maxWorkers≤48，CI 保 Vitest 默认）。我方 `coverage-policy.ts`/`coverage-scoped.ts`/`test-invariants.ts` 抽象层保留——上游内联重构不覆盖。

P1 剩余：

- `coverage-partitions.ts` 剩余：`vitest list` 改 JSON 清单（我方 parseListOutput 仍解析文本行）、`.coverage-times.json` 时长史 reporter——我方已有自有 `COVERAGE_TIMINGS_FILE`/`coverageTimingCacheKey`/`readFileDurations` 实现，需对账是否等价或上游新增独有逻辑。
- `vitest.config.ts` 剩余：`resolvePwshPath` 探测接入（上游用其实现 pwshCoverageExclusions）；`test-invariants.ts` 上游已删但我方有 +14 行自有不变量——保留决策；`sourcePlaneAliases`→`claudeCodeTestingAliases` 改名跟随与否。
- `run-gates.ts`/`.spec`：加 `ci-unit` 模式、`ConcurrencyDefault` 导出（带诊断来源）、parallelism default 接入 `defaultConcurrency`、sharedHygieneGates；我方 +191 行 CoHarness 车道逐条保留。
- `ci.yml`：`.coverage-times.json` restore/save 缓存步骤（先核对——我方时长史系统已存在，ci.yml 可能已有等价缓存）；`sandbox.yml`：check:ci:unit 道（依赖 run-gates ci-unit）。
- `package.json` scripts / `tsconfig.base.json`：上游 ±200 行别名面改动多数挂在未携带包上，随各包携带相位吸收。
- `gen-third-party-notices.ts`：inspector devtools 披露 import 依赖 P8 的 inspector 携带决策；examples//yao-pkg/ruff 条目上游删除均不适用于我方现状。
