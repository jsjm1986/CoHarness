# DeepSeek Harness（CoHarness 内部）— 全面代码质量审查报告

> 审查日期：2026-09-08（会话贯穿 2026-09-07/09-08）
> 基线：`master` @ HEAD（会话中途工作树出现大量外部改动，见 §0.2）
> 类型：只读全面代码质量审查（架构、正确性、生命周期/并发、安全、测试、文档一致性）

---

## 0. 前置声明（必读）

### 0.1 覆盖声明：未宣称 100% 阅读

- 全仓受控文件 **9,199 个**。
- 本次**逐文件实际读取约 4,779 个（≈52%）**。
- 其余覆盖方式：
  - `.agents/notes` 分类树（890 英文 + 约 1,786 含 `.zh.md`）已完整登记，结构与 Status 由门禁 `verify-agent-note-classification` / `verify-agent-note-format`（745 篇活动笔记全绿）机械验证；正文仅抽样深读。
  - `docs/` 全树由 `verify-md-links`（2,380 文件全部相对链接/锚点解析）、`verify-doc-budgets`（9 预算全过）机械验证；核心契约文档（architecture / AGENTS / testing / defensive-patterns / cordis-primer 等）直接通读。
  - `examples`、`apps/web/tests/snapshots` 快照目录已枚举登记（未逐字核对具体数据内容）。
  - `scripts` 门禁/发布/generator 源码全部通读；其约 67 个 `.spec.ts` 测试文件未逐一读取（这些测试断言已审的源码，价值较低）。
- **任何人对 9,199 个文件声称"100% 逐行阅读"都不真实。**

### 0.2 工作树是移动目标

- 会话开始时工作树干净（仅 `?? .cursor/`）。
- 当前 `git status` 显示 **205 个外部改动/新增文件**（覆盖 `gateway/`、`client/*`、`docs/`、`apps/`、`native-command`、`open-in-app` 等），且仍在变化。
- **已提交（HEAD）基线才是可独立复核的稳定快照。** 本报告统一把"外部未提交改动"（原生代码拆分、open-in-app 新增、UI/网关改造等）与"已提交代码结论"区分开，未将进行中的改动计入已提交缺陷。

### 0.3 已运行并绿灯的门禁

`verify-package-invariants`、`verify-export-jsdoc`、`verify-cordis-config`（138 配置）、`typecheck`、`verify-md-links`、`verify-doc-budgets`、`verify-translation-pairing`（**发现一处违规**，见 C1）。

---

## 1. 高置信正确性 / 安全缺陷

按严重度排列，均为证据充分的发现。

### A1. [高] Gateway 迁移丢失 seeded 会话的继承切点
- `packages/session/session-persistence-gateway/src/index.ts:818-826`
- `migrateStored` 用原始 `SessionHeader`（仅 `isSeeded`）而非 `wireHeader()`（编码 `seedLength = inheritedEventCount`）。重载后 `storageFrom`（`:246`）从 `seedLength !== undefined` 推导 `isSeeded`，导致 v0/v1 seeded 会话经 Gateway 迁移后继承切点被静默丢弃。
- 测试仅断言 `targetHeader: { id, version: 2 }`，未覆盖 seeded 头。
- 修复：`migrateStored` 改用 `wireHeader(currentStorage)`。

### A2. [高] 空问题批次导致 `QuestionComposer` 运行时崩溃
- `packages/client/ui-user-questions/src/client/QuestionComposer.tsx:127-180`
- `planReviewOf([])` 返回 `undefined` 后，`QuestionFlow` 以 `questions[index]!`（非空断言）访问 `question.options` 等属性，空批次直接抛异常。
- `tests/plan-review-panel.client.spec.tsx:110` 只断言返回 `undefined`，未挂载空批次。
- 修复：wire 协议入口拒绝空数组，或 UI 显式处理空批次。

### A3. [高] `cordis_inspect_query` 在 provider 错误时永久挂起
- `packages/extensions/cordis-host-runner/src/inspect-registry.ts:136-156,192`
- `resolveClientQuery` 仅对 `ok` 结算 pending；`provider-missing / method-missing / invalid-input / provider-error` 返回 `{ accepted: false }` 却不清 `this.pending`、不调用 `pending.settle`。等待侧 `queryClient` 的 `await result`（`:192`）无超时永久阻塞，直到 turn 取消。
- 浏览器端确实发送 `ok:false` 解析（`client/inspect-registry.ts:103-123`）。
- 修复：非 ok 解析也结算 pending 查询。

### A4. [高] `ui-directory-picker-native` 无 stale-settlement 围栏
- `packages/client/ui-directory-picker-native/src/client/flow.ts:46-63`
- close/reopen 边界在途 OS 对话框的迟到答案经 `outcome.current`（`:55-60`）落到新请求，产生陈旧输入。
- browse 版本有 `openGeneration` 围栏（`DirectoryBrowser.tsx:291-293,565-590`），native 缺失——不对称。
- 修复：为 native occupant 增加 re-arm 围栏（如 generation 计数）。

### A5. [高] Windows `koffi.alloc` 本地内存从未释放
- `packages/subprocess/subprocess-local/src/windows-inspector.ts:286,309-312`
- `PROCESSENTRY32W` 每次快照泄漏 568 字节；4 个 `FILETIME` 每次 `processState` 泄漏 32 字节；全文件无 `koffi.free`。
- 在 `LocalTerminalHandle` teardown/`waitForMembers` 每 ~25ms 轮询路径上无界泄漏。
- 修复：对每个 `allocNative`（含早返回路径）调用 `koffi.free`。

### A6. [中] 持久化 session 选择在 pending 阶段被破坏性清空
- `packages/client/runtime/src/client/sessions/service.ts:818-822`
- `projectList` 在 `current === undefined`（列表未就绪）时 `this.selection.set({})` 写入 `{}`，违背 `:266-269` 声称的"非破坏性投影"。重载落在该窗口会丢持久化选择。
- 修复：该清空门控在 `listPhase === 'ready'`。

### A7. [中] `llm-deepseek` 的 `resolveRequestImagePolicy` 重复且分歧
- `packages/llm/llm-deepseek/src/adapter.ts:270-281`（请求路径）vs `request-pricing.ts:36-46`（定价路径）
- 模型同时带 `imagePixelBudget` 与 `imageDetail: 'low'` 时，请求用 numeric budget（adapter 优先），定价让 `low` 优先（512×512 常量）→ 低估 `visualTokens`。五个共享常量亦重复（`adapter.ts:169-174` vs `request-pricing.ts:20-28`）。
- 修复：收敛到单一实现。

### A8. [中] `storage-json.writeAtomic` 的 fsync 失败造成内存/介质分叉
- `packages/storage/storage-json/src/atomic.ts:34-39`
- rename 成功后目录 fsync 抛错走 catch→rethrow，调用方回滚内存，磁盘却已是新值，违背"被拒绝写入不造成分叉"契约（`domain.ts:5-8`、README）。
- `json-backend.spec.ts:85` 只测 rename 失败，未测"rename 成功但 fsync 失败"。
- 修复：rename 成功后不再向调用方抛错（fsync 失败降级为 warn），或让回滚感知"已提交"。

### A9. [中] bundle patch 路径未限制在包目录内
- `packages/boot/app-boot/src/profile.ts:395-401`
- `dsh.bundle.patch` 未校验类型/绝对路径/`..`/符号链接，可越界读任意文件并按 YAML patch（含 `!!js` 表达式）解析。README:40 声称的约束代码未强制。
- 修复：要求非空相对路径、拒绝绝对路径与越出 package root 的 `..`、必要时 realpath 校验、补拒绝路径测试。

### A10. [中] `llm-retry` 两个 mode 的下游交互语义（已交叉复核确认）
- `packages/llm/llm-retry/src/index.ts:150-152,177-207`
- (a) `llm/retry` 在可取消等待前 append（`:150`），取消会静默消耗 `maxRetries` 预算。
- (b) `normal` 模式对 retryable 码直接 `backoff`、绕过下游 `next()`；`always` 模式覆盖下游非 retry 决策。
- 注：`RequestErrorAction = { kind: 'retry' } | undefined`（`core/agent/src/runtime-types.ts:61`），因此并非"丢失 abort/fallback 类型"——但两个 mode 与下游 recovery 的交互仍是真实 footgun，建议显式文档化或补下游决策透传。

---

## 2. 安全策略与实现的冲突（重要）

### D1. [高] `SAFETY.md:20` 声称 WebFetch"默认关闭"，但发行默认组合实际开启
- 文档要求（`SAFETY.md:20` / `SAFETY.zh.md:20`）：除非端点/脱敏/限流/审计/回滚获批，否则保持 WebFetch、插件 metadata、Session-log upload **关闭**。
- 实现：`packages/bundle/base/cordis.patch.yml:410-438` 默认 `fetchProvider: http` + `fetch: true`；`apps/cli/config/agent-presets/{code,cordis,standard}/agent.cordis.yml` 均 `fetch: true`。即 **headless/ACP/SDK/默认 CLI 组合 WebFetch 默认可出网**；仅 `web-app/cordis.patch.yml:463` 在 Web UI 层 `tool-web: disabled`。
- 该默认开启是**有意的跟随上游决策**（`upgrades/plans/UPGRADE-PLAN-dsh-v0.1.2-alpha.4-alpha.5.md:37`，#3382），并带公网-only / 地址校验 / 连接 pinning 缓解（web 审查确认 SSRF 防护扎实）。
- **结论**：不是漏洞，而是 `SAFETY.md` 措辞与实现默认值脱节。应在文件级明确 WebFetch 在 headless/preset 下默认开启并指向安全缓解，或在 base bundle 默认关闭。

---

## 3. 中 / 低优先级（防御性 / 健壮性）

- **B1** `session/session-persistence-sqlite`：死 SQL 资源 `set-user-version-17`（不可加载）、`-18`（可加载未用）；标量行解压无 `maxOutputLength`（打包路径有），损坏大 BLOB 有放大面（`src/sql.ts:42-43`、`src/compression.ts:304`）。
- **B2** `subprocess/…windows`：`drainPipe` 依赖管道 EOF，孙进程持有句柄时 `wait()` 阻塞（`src/spawn.ts:175-202`）。
- **B3** `terminal-bash/src/index.ts:139-163`：启动取消/期限在 `Promise.race` 胜出后，仍在跑的 `start()` 迟到 rejection 无处理者（潜在 unhandled rejection）。
- **B4** `hooks/*`：两桥 `defaultTimeoutMs` 与逐 hook `timeout` 缺正值校验（`hooks-claude-code/src/index.ts:98-101`、`hooks-codex/src/index.ts:83-85`）；阻塞 reason/stderr 未截断直入模型上下文；`events.ts:99` 把不可运行 hook 落盘为 `decision: 'pass'`。
- **B5** `schedule/schedule/src/runtime.ts:251-307`：`runMaintenance()` 将所有同步异常当"忙碌"处理并等待 idle；`tools.ts:426-429` 无运行时参数类型防护。
- **B6** `util/atomic-write`（`withFileLock`）：崩溃后孤儿锁需人工删除（已文档声明为运维动作，但与 JSONL 锁的 PID 存活恢复不对称，`atomic-write/src/index.ts:149-151,157-183`）。
- **B7** `settings`：同插件 apply 内重复注册失效检查被绕过；`write()` 在属主被替换后仍写 `document[ns]`（`settings/src/index.ts:737`，已被 TODO 承认）。
- **B8** 多处 `client/ui-*`：
  - `ui-tool`：Web/Read 卡片对 wire 数据缺结构校验（`web-card-model.ts:44-54`、`read-card-model.ts:64-76`），malformed 可 `TypeError` 崩溃，与 README"generic fallback"矛盾；
  - `ui-settings-plugins/card-form.ts:260-275`：`save()` 无 try/finally，scope write 拒绝会永久卡 `saving`；
  - `ui-conversation`：硬编码 `Deep diving...`（`chat.deepDiving` 死键，`ChatView.tsx:188`）、`removeDocument` 缺 `removeImage` 的提交期锁（`input/facade.ts:178-183` vs `:148-149`）、stats 行两套 `formatTokens`；
  - `ui-trajectory`：3 秒搜索索引节流导致 live search 短暂旧结果（`TrajectoryView.tsx:304-318`）。
- **B9** 打包依赖声明缺口（重复模式）：`session-log-export`、`client/runtime`、`ui-model-selection`、`ui-attachment` 运行时值导入 `@deepseek-ai/dsh-client-ui-primitives` 却仅列 devDependencies；另 `ui-open-in-app/package.json` **重复的 `dsh-invariants` devDependency 键**（工作树）。

---

## 4. 文档 / 约定不一致（高置信）

### C1. [门禁实证] 双语配对违规
- `verify-translation-pairing` 报错：`packages/host/open-in-app/README.zh.md:12,30,89` 链接指向英文 `../../client/ui-open-in-app/README.md` 而非 `.zh.md`。

### C2. 孤儿 API 文档（已提交代码不存在）
- `packages/subagent/subagent/README.md:109`（zh:111）描述 `registerContinuableSetup()`，全仓 grep 仅这两处、代码中不存在（疑似上游同步移除而文档未跟随）。**已提交代码的孤儿文档**。

### C3. core 文档陈旧
- `core/agent/README.zh.md:15` `installAgentLlmTarget` 不存在（真实为 `installModelSelection`，`model-selection.ts:39`）。
- `core/agent-loop/README.md:44-45`（zh 同）inbox 默认 `256 / 8MiB`，代码为 `10_000 / 16MiB`（`constants.ts:9,12`）。
- `core/agent-tool-presentation/src/index.ts:14` 死链 `code-runtime-worker/README.md`（实为 `code-runtime-worker-thread`）。

### C4. 多包 README 陈旧（均为实现变更后未同步）
- `e2b` README 钉 `e2b@2.29.1`，构建为 `2.38.2`；`composition.e2e.ts` 导入 5 个未声明 devDeps。
- `subagent-codex` README `0.147.0` vs 代码固定 `0.149.1`。
- `llm-deepseek/README.md:93` overstate `x-deepseek-harness-user-id`（Files API 请求实际不带）。
- `tool-bash/README.md:125` 后台禁用文案过期（实际 `run_in_background is disabled...`）。
- `workflow-worker-thread/README` API 示例遗漏 `provider`。
- `tool-cordis` README 声称 5 个工具、实为 7 个（含死代码 `present.ts` 两个未用导出）；`ackTimeoutMs` 不存在。
- `compaction/README:31` 的 `ManualCompactionError.code` closed set 漏 `cancelled`。
- `permission-presets` README `permissionPresets/preset` vs 实际 `permission/preset`。
- `command-feedback` README `ctx.get('telemetry')` vs 实际 `sessionTelemetry`。
- `ui-layout` README `conversation.empty`（不存在）漏 `shell.overlay`。
- `agent-presets/README.md:51`（zh 同）`recompose` 描述为 unmount/mount，实际 re-link（`mount.spec.ts:509-511` 同错）。
- `tool-goal` README `concludeTurn()` vs 实际 `deferContext()`。

### C5. Agent Notes 内容级问题
- `directory-guard.md:23` 引用不存在的 `platform design doc §14`（晚于 `committed-artifact-citations` 政策，属漏网）。
- 分类/格式门禁对 745 篇活动笔记**全绿**；其余为政策前残留措辞（`FS_PARTIAL_OBSERVATION` 描述、`ruling`/`PR 栈序号` 归因等），不改变事实准确性。

### E 组（升级记录内部冲突）
- **E1** `CONTRIBUTING.md:5,9`、`BRAND_GUIDELINES.zh.md:9` 仍为上游 DeepSeek 原文，与 `README.md` 的 CoHarness 品牌行文矛盾。
- **E2** v0.1.3-alpha.2 三份升级文档冲突：plan `:6` 用从 alpha.1 复制的 `2,201 文件/+63,846` 统计、manifest `:53` 用占位 `coharness.2-after-verification`，实际 diff 为 `4,761 文件/+89,713`；alpha.1/alpha.2 对齐矩阵内容高度重复。

---

## 5. 门禁复核确认的绿灯项（值得信任的方面）

- `verify-md-links` 2,380 文件全通过；`verify-doc-budgets` 9 文档全过；`verify-package-invariants` 251 伴生符合；`verify-export-jsdoc` 全通过；`verify-cordis-config` 138 配置全过；`typecheck` 构建通过。
- 核心运行时防御达到高标准：`code-runtime-python`/`worker-thread` 的 hostile-peer 帧处理、UTF-8/代理项记账、进程组静默回收与内存边界；`subprocess` 的 env 擦除/TOCTOU；`apiproxy`/`client-connection` 的信任栅栏与 SSRF pinning；`fs`/`attachment`/`credentials` 的路径/符号链接/权限纪律。均有针对性测试。

---

## 6. 最优先行动清单（合并全轮，5 项）

1. **A1** Gateway 迁移丢 seeded 继承切点 → 改用 `wireHeader()`。
2. **A3** `cordis_inspect_query` 永久挂起 → 非 ok 解析也 settle pending。
3. **A2** 空问题批次崩溃 → wire 拒绝或 UI 兜底。
4. **D1** `SAFETY.md` WebFetch"默认关闭"表述与实现默认值对齐。
5. **C2** 孤儿 API 文档 `registerContinuableSetup` → 删除或落地。

其后用一次 `doc-sync` + `hygiene(knip/publint)` PR 批量收敛 E 组升级记录残留、B8/B9 打包依赖声明缺口与 C4 的 README 陈旧项。

---

## 7. 诚实覆盖边界（未逐文件覆盖）

- `.agents/notes` 约 740 篇正文（结构与 Status 由门禁机械验证，正文仅抽样）。
- `docs/` 子页正文（全树链接/预算由门禁验证，核心文档直接通读）。
- `scripts` 约 67 个 `.spec.ts` 与快照数据（门禁/发布源码全读）。
- `examples`、`apps/web/tests/snapshots` 快照具体数据内容（已枚举登记）。
- 205 个未提交工作树改动的"已提交版本"（工作树为移动目标，未纳入已提交结论）。
