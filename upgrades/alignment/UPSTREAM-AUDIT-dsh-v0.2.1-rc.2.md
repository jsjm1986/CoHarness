# CoHarness → dsh-v0.2.1-rc.2 上游审计

## 范围来源与核对方法

本轮目标 `dsh-v0.2.1-rc.2`（`687f282e8625c6b8d11ff58211a90524be2e4317`），自上一轮已验收基线 `dsh-v0.2.0-rc.1`（`4878cdabd87d4041bdaff61d04c966883b9fd07a`）起累计 **2,112 个提交（其中 1,622 个非合并，清单登记口径；848 个触碰本地携带包）、9,323 个变更路径（`--no-renames` 原始矩阵口径；rename 检测口径 8,705 条需 `diff.renameLimit≥2904`）、395 个唯一 area、30 条 gate replay 复审（23 条上游改动已逐条复核登记）**。

中间 tag `dsh-v0.2.0-rc.2`、`dsh-v0.2.1-alpha.1`…`alpha.5`、`dsh-v0.2.1-rc.1` 经 `git merge-base --is-ancestor` 逐一验证均为 rc.2 的线性祖先，直接以 rc.2 为唯一比较目标；中间状态审查由既有台账承接：[alpha.2 审计](UPSTREAM-AUDIT-dsh-v0.2.1-alpha.2.md)（272 提交逐条判定 + 已移植表）与 [alpha.4 发布说明台账](UPSTREAM-RELEASE-NOTES-LEDGER-dsh-v0.2.1-alpha.4.md)（729→558 条逐条判定）。

## 插件/组合面机制核对结论（本审计先行核定的面）

- **版本检查器** `packages/boot/app-boot/src/plugin-compatibility.ts`：本地副本与 rc.1 基线逐字节一致；上游净增量仅 `engines.dsh` 声明分支（声明则单独裁决、跳过 peers）与字段命名（peers→requirements）。`workspace:*`→runtimeVersion 钉版与 `includePrerelease` 本地本已存在。判定为 adapted 增量吸收，不构成兼容风险。
- **vendored 运行时**：`vendor/loader/src/config/entry.ts` 本地与 rc.2 逐字节一致（`moduleNamespace`/HMR 演进已携带）；`vendor/cordis/src` 上游窗口内零改动（仅 package.json 版本号 4.0.4→4.0.5）；本地 vendor 改动全部登记于 `vendor/README.md`（fiber 生命周期加固、include 序列化、lazy config 解析等）。
- **patch/overlay 语义**：`insert`/`disabled` 读取语义上游零改动；`dsh.bundle.patch` 机制原样存在；`plugin-manager/patch.ts` +44/-9 为编辑侧去重优化（id+disabled-only override 在已达值时省略），不改变已交付 patch 的应用结果。
- **自有插件** `plugins/dsh-{directory-guard,model-governance,steward-tools}`：上游无对应物；patch 引用的 12 个包全部在本地存在；`dsh-model-governance` 的过期精确 peer 钉版已修（`02878d4` 后随 `06614fcfd33` 落地，peer 一律 `*`）。

## 同名遮蔽（upstreamShadowed，本轮新增 2 例）

- `packages/session/tool-working-directory`：上游 rc.2 同键新包删除了工具契约里的「目录必须留在项目内」约束；我方 owned 实现保留项目边界准入。**不采纳上游无界形态**。
- `packages/session/working-directory`：上游同键新包仅校验绝对路径与存在性；我方 owned 服务含准入策略（`WorkingDirectoryError`、项目根包含保证、canonical 解析）。**不做文件级归并**。

## 上游结构性移动（需逐条处置）

- **降级至 experimental/（13 包）**：`hooks/hook-protocol`、`hooks/hooks-claude-code`、`hooks/hooks-codex`、`webhook/webhook`、`webhook/webhook-github`、`terminal/tool-terminal`、`workflow/tool-ralph`、`skill/skill-badge`、`session/session-title-all-prompts-llm`、`subagent/subagent-in-process-driver`、`session-query/tool-session-query`、`runtime-diagnostics/invariants` 原位删除并移入 `experimental/`（含重命名变体）。是否跟随降级为业主决策——本地原位携带保持功能，但 `runtime-diagnostics/invariants` 与 `session-title-all-prompts-llm` 的 tsconfig/vitest 别名上游已摘除。
- **上游新增（41 包）**：含 `boot/plugin-market` + `client/ui-plugin-market` + `util/plugin-market-index` + `experimental/plugin-market-bundle`（插件市场分发体系）、`api/remote-access`、`experimental/{cua,cua-macos,session-inspector,claude-code-mods,client-ui-claude-code-mods,cot-translation-bundle,client-ui-cot-translation,translator,session-search,worktree,tool-worktree,inspector-profile}`、`schedule/tool-schedule`、`ssh/ssh-helper-runtime`、`web/web-deepseek-api`、`client/ui-secret-mask`、`client/ui-deepseek-model-label-1017`、`context/harness-dev-context` 及 hooks/webhook 等的 experimental 重挂位。
- **CI/门基础设演进**：`scripts/parallelism.ts` 新增（本地 worker 预算 shared by run-gates/run-oxlint/vitest）；coverage 分区改造为 `coverageTestTimeoutOptions`（值传递而非 argv）；`check:ci:unit` 车道；`DSH_COVERAGE_TEST_TIMEOUT_MS` 共享 runner 预算；`build:artifacts`/`build:check` scope；pnpm 11.28.5；action pin 全量 bump（checkout v7.0.1 等）。

## 决策占位

逐包/逐提交的处置状态以矩阵行 `reviewState` 与[升级计划](../plans/UPGRADE-PLAN-dsh-v0.2.1-rc.2.md)为准；[清单](../manifests/UPGRADE-MANIFEST-dsh-v0.2.1-rc.2.json)登记业主决定。本审计不声明任何实现或验收完成。

## 证据限制

- 机制面结论为源码 diff 级核对；包级 commit 的意图级判定随相位推进逐条登记。
- 未验证台账照旧：真实浏览器双用户、生产部署、Linux/Windows 平台项在各相位完成后登记，本审计不声明任何项已验收。
