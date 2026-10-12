# 上游对齐审计 — dsh-v0.2.1-alpha.2

## 审计范围与方法

- 目标基线：`dsh-v0.2.0-rc.2`（`c1b47e41fcd`）；演进面：`rc.2 → master HEAD(0.2.1-alpha.2, d7432673886)`。本地检出 `/tmp/dsh-upstream-rc2` 与 `/tmp/dsh-upstream-master`；fork 与上游无共同祖先，全部结论基于逐文件源码与提交 diff 核对，不凭包名或提交标题推断。
- 覆盖：283 个共享包 + 上游 33 独有包；约 272 个上游提交逐个核对（0.1.7 系列 110 个 PRE 窗口 + rc.1→master 162 个 fix/perf/client）；工具/config/persistence 三份生成式 catalog 均为最新且语义一致；system prompt 快照比对无模型可见差异。
- 主权清单 `scripts/upstream-sync.json`：317 包（adapted 222 / tracked 58 / owned 35 / replaced 2）；tracked 层抽查逐字一致。对齐矩阵 359 行中 322 行仍为 `pending-cumulative-source-review`——本次漂移根因，根治项见末节。
- 结论分级：P0 架构级 / P1 正确性·安全·挂起 / P2 用户可感知 / P3 视觉·性能·文案；并区分 `N/A-DIVERGENT`（有意分歧）与 `N/A-EXCLUDED`（不携带包系）。

## 已移植（2026-10-12 ~ 2026-10-13）

| 上游提交 | 内容 | 本地落点 |
|---|---|---|
| `0aed8de976d` | 请求扩展逐字段容错：provider prepare 失败只省略该字段并首次告警，仅取消整体拒绝；accept 失败经 `onExtensionsUnaccepted` 上报不致命 | `packages/llm/deepseek-llm-api-extensions`、`packages/llm/llm-deepseek` |
| `7facb1cf65d` | 降级重放/省略路由/未接受路由警告按 route 去重 | `packages/llm/llm-deepseek/src/host.ts` |
| `193f9ce4130` | `dsh_session_log` 加 `maxBytes`（默认 8 MiB），发送可装入的最长待传前缀，超限首事件省略并单次告警；接受记录与 envelope 携带 `sessionFormatVersion`，跨代际水位忽略 | `packages/session/session-log-deepseek`（保留 enabled:false 默认、allowedEndpoints、killSwitchEnv、audit 自有门禁） |
| `11a0f85b340` | Python PTC 接入共享 `sandbox`/`sandboxPolicy`：`sandboxMode`、策略解析、`ConfinedArgv`、stdin 载入 bootstrap（取消逐次临时拷贝）、`AbortController` 结算 | `packages/experimental/ptc-runtime-python`；上游 `ptc-python-read-only` 夹具不携带（v4 codec + working-directory 段我们未接纳），`ptc-python-turn` expected schema 已重生成 |
| `cafb9b93b4b`（subprocess 部分） | spill 路径在 `openSync` 成功后才发布（EEXIST 不再删外部路径）；抛错 reporter 收敛到 stderr；`logSpillFailure` 共享所有者日志行 | `packages/subprocess/subprocess-local`、`packages/ssh/ssh` |
| `0c44e5461db` | 附件发现只扫声明的一方载体字段；opaque/ignorable 事件与 `tool-result` 嵌套不再触发存储读取 | `packages/host/apiproxy`（`imageInEvent` + `session-export.ts`，保留 `assistant/chunk` 载体） |
| `ad83cce36ac` | V3 重启修复：`next-turn` splice 后开 `turn+1` 且非开步时合成 `turn/end interrupted`；`image/offload` `targets[].seq` 纳入引用重映射 | `packages/session/session-format-v3-to-v4`（适配到 CoHarness 折叠阶段，非逐字） |
| `b6775f6d4f5` + `2d653be7b0e` | `maxConsecutiveWakes` 去掉 `.default(10)`，空闲所有者默认每次完成都唤醒 | `packages/jobs/tool-jobs` |
| `f37f19ab43a` | 可执行文件错误按 `name` 比较（跨 realm 安全）；`SubprocessExecutableNotFoundError` 移出 `peerRequiredHostExports`，新增 `requiredServicePeers` 策略通道 | `packages/api/terminal-controller`、`packages/ssh/ssh`、`scripts/verify-package-dependencies*` |
| `1e6630a8568` | Team mailbox fold 对未知内容块只校验 `type` 标签、保留解码 JSON（含 own `__proto__`）；上游 projection checkpoint bump 不适用（CoHarness fold 为纯重放） | `packages/experimental/agent-team/src/fold.ts` |
| `9a8d21dfe75` | 取消的排队 goal Round 在 idle 检查点从 inbox 撤回；revision 精确匹配的取消暂停 goal；结算失败告警并撤防 | `packages/goal/goal-round-driver` |
| `18a4bc4093c` | `exit_plan_mode` 接受 `{ approved: boolean }`；`ASK_CANCELLED` 结束轮次并返回 `{ approved: false }`，计划模式保持激活 | `packages/plan/plan-mode` |
| `a1da7bcfb96`（部分） | `waitForChildren` 适配到 `ContinuableActivationRegistry`；headless 循环 `whenIdle` + `waitForChildren` 直到父级 idle 且 seq 不变。结算消息的 `structured`/`diagnostic` 传递不适用：我们 `ActivationTerminal` 无 structured 通道（独立功能缺口，见下） | `packages/subagent/subagent`、`packages/bundle/headless` |
| `1d37aabe99c` | `all-prompts` 标题修订把现行 provider 生成标题作为 JSON 数据传入并附保留指令（仍贴切须原样返回；话题实质变化才改）；用户/兜底标题不进入该输入；标题计入 `maxInputBytes` | `packages/session/session-title-llm` |
| `b981255be6d` + `0516f66d832` | 指令文件去重副本恢复对账资格（保留内容的重复项可提升；预算省略者的重复项继承排除）；组内任一候选（含隐藏重复项）元数据/内容不可读时整组冻结，且为全组成员保留绝对路径防别名绕行 | `packages/context/agent-instructions` |
| `02f54230705` | `discoverModels` 先解析凭据：`MISSING_CREDENTIAL` 返回空目录隐藏路由，其余错误传播 | `packages/llm/llm-deepseek-api-key` |
| `59ba1321eba` | Windows 终端分配传 `useConptyDll: true`（node-pty 自带 OpenConsole 承载，POSIX 不变） | `packages/subprocess/subprocess-local` |
| `edd0660b5d0` + `fc30c5a7d25`（服务端侧） | `answer` 按 Session 保留排队回复直到录取：重复提交 `REPLY_QUEUED`、丢弃/认领轮次终结释放、`agent/inbox/claimed` 接管恢复回复；fold 改为仅 `user/message` 录取时结算并折叠 pending `tool/ptc-dispatch` 子调用；Client 侧等价机制（PendingWait/publishInteraction）此前已存在 | `packages/interaction/user-questions`（projection `stateVersion` 4→5） |
| `820824edd74` | 输入回显录取所有权：逐身份 `queueTarget`/`queueIndex`/`queueSeq` 回执跨 `session/queue` 帧、`queuedInbox` 投影与 `agent/inbox/spliced`；queued 回显入队即退、transcript/steering 等持久录取+行移除；`canceled` splice 立即失败、离队未录取回显在下一 `request/context`/`turn/end`（seq 晚于移除观察）失败；新 follow 基线把 `asOfSeq` 及之前的队列观察身份按已观察接受；`ProjectionValueStore.seqOf` 暴露水位；`BeginSubmissionInput` 改携 `mode`，placement 由 Session 实时 running 派生 | `packages/client/runtime`（session/projection-store/contract）、`packages/client/ui-conversation`（ChatView/QueueDock/service）；上游 Playwright e2e 未移植——wire 面不同（`session/queue`+`queuedInbox` vs `session/control`/`session/follow`），需重写 |
| `08c0e8e71b6` | 已录取本地身份抑制其仍发布的队列行直到行消失：ChatView steering 行与 QueueDock transcript 行按 `rpcId` 匹配；渲染去重只在持久节点持有 `rpcId` 后隐藏回显，队列占位不隐藏（与上游「stale inbox 行在 projection 水位追上前保留」等价，适配我们的整体快照队列面） | `packages/client/ui-conversation`（ChatView/QueueDock）、`packages/client/runtime`（session retireAdmitted） |
| `1b55f5bea3a` | 成功 `assistant/message` 结算在流结束即发布，瞬态行保留到匹配 `step/end`（携带 `retireAttemptId`）；被中断 message/attempt 仍在流结束结算；保留期间新 attempt 请求 rebaseline；Assistant 节点把成功 message 锚定在首个可见 seq | `packages/client/runtime`（assistant-stream/session/conversation-assembler）、`packages/client/ui-conversation`（conversation-nodes/assistant） |
| `96c421d9857` + `500295b2bdf` + `699f1a8dc18` + `1b1b09e1fbe` | Schedule 子 agent 归属：`create` 抛 `ScheduleInputError('subagent_session')`、`update` 返回非变更 `subagent_session` 结果，均按目标 Session 活跃 Agent 的 `delegationDepthOf > 0` 判定；四个 `schedule_*` 工具在分发前以同一记账拒绝委派调用方；`SubagentSessionError` 进入 `ScheduleToolError`/update 结果/输出 schema 联合；UI `timingError` 映射双语 `timing.subagentSession`。上游 preset `toolFilter.deny` 不适用：本地 schedule 工具为 root Agent 作用域注册（非全局名），deny 未知名会使 `tools.restrict()` 启动失败；root-only 注册使子 prompt 本不含工具，逐工具拒绝兜底直接执行路径 | `packages/schedule/schedule`（domain/types/index/tools + `dsh-subagent` peer 边）、`packages/client/ui-schedule`（task-timing/locales） |
| `6fe4a2e184e` + `980b410340b` + `d7d2e5fd4ed` + `b1c5f861b66` + `a59beb8ae30` + `14e9bf61cb3` | HMR 包清单失效族：新增 `package-manifest.ts` 封装 Node 内部接口——`package.json` 变更（含 node_modules 外）使 ESM `ResolveCache` 与 CJS `_pathCache`/`_load` 请求失效而不驱逐已评估模块；按原始 `moduleNamespace` 匹配已加载 entry（manifest 变化不丢身份、同名不同 namespace 各自成实例、替换共享 runtime 的 entry 并在失败时回滚）；上游终态 `index.ts` 整取 | `packages/boot/hmr`（src/package-manifest.ts + index.ts + 新增 spec/fixture）、`vendor/loader/src/config/entry.ts`（`Entry.moduleNamespace`）；本地 `36e88dce207` |
| `869afc493df` + `abf8b760ecc` + `00b363074a2` + `bab69fbec59` | 包操作刷新运行时解析：`createRuntimeResolution` 返回 `ProfileRuntimeResolution`（记忆 installAnchor/home/profileDir，`computeLatestResolution` 重读磁盘不保留合成层）；`PluginPackages` 记录 `current` 并新增 `refresh()`（非 `ProfileRuntimeResolution` 拒绝重算）；`ResolutionRouter.replace` 允许移除 profile 作用域映射与本地包名，保留映射可换 declarer，安装锚点不变。plugin-manager：enable/install/remove 经 `refreshPackages()` 在 HMR 事务内发布；`removable` 覆盖「已选中但无包」名（其移除止于取消选入、不跑 pnpm）；`installBundle` 结果携安装后清单 `version`；`listBundles` 错误路径携带已读到的 `version`。本地适配：link 模式无拦截层，`refreshPackages` 经 `pluginPackages.installed` 门面跳过（不丢上游对 plain-data resolution 的 fail-loud） | `packages/boot/app-boot`（profile.ts/service.ts/resolver.ts）、`packages/boot/plugin-manager`（index.ts）；`dropRetiredBundles`/`RETIRED_BUNDLES` 分歧——本地 schedule-bundle 仍发布，无退休集合，已有 `normalizeShippedProfile` 处理 tuple 退休；本地 `36e88dce207` |
| `2c676339904`（CLI 面）+ `0e5ab657587` + `72a60d5d6e8` | CLI 版本豁免命令面：`dsh plugin` 在转发 pnpm 前拦截 `version-exemptions`/`allow-version`/`revoke-version` 三个 DSH 自有命令，其余参数照转 pnpm；授权要求 `--accept-risk` 并在保存前打印风险警告，经 `setProfileVersionExemption` 校验精确 `name@version` 与运行时版本，与包操作同持 profile manifest 写锁（`package.json.lock`）；非 Desktop profile 缺失时按 `PROFILE_TEMPLATES`/`DEFAULT_PROFILE_BUNDLES` 初始化，`desktop` profile 必须已存在；`bin.ts` 经 `RunCliOptions.packageManager` 转发安装持有的包管理器配置；兼容性拒绝为每个被拒包打印精确 `allow-version` 命令，修复死路指引 | `apps/cli`（plugin.ts/bin.ts + plugin.spec.ts 22 用例 + plugin-compatibility.expected.e2e.ts 真实 pnpm 验收）；豁免架构本体（`profile-compatibility.ts`/`plugin-compatibility.ts`/`operations.ts` 拒绝路径/`plugin_manager` 工具）早前经聚合合并已在树内，本批补齐其引用的 CLI 命令面；本地 `6dbc982c73d` |
| （上游现态契约，无单一提交） | 空白会话页头 corner 存活：`ConversationSessionHeader` 的 `conversation.session.header.corner` 移出 blank-chrome 守卫——上游 `hideChrome` 只收起标题/标签/actions/utilities,corner 挂载不中断；`.headerHidden`→`.headerBlank`(去分隔线、corner 空时整行折叠）;`ui-sidebar-right` 删除 `BlankExpandButton` 及 `conversation.input.left` 注册（corner 存活后属重复控件） | `packages/client/ui-conversation`（ConversationSession.tsx + module.css）、`packages/client/ui-sidebar-right`（ExpandButton/index + spec)；本地 `2f4b0fee56e` |
| `5577becafe1` + `6200ffe8c78` + `3c17f569da5` + `5d7a1f14e4a`（语义对齐，非机械移植） | Coding Tools 关时 Creator stage 落地：上游契约是「偏好关断转换清 stage、此后产生的 stage 仍落地」，本地把检查做在 `apply()`/`load()` 的 compose 时点（持续拒绝），导致偏好已关时 Creator 入口 stage('cordis') 在 chip mount-load 或会话到达时被静默丢弃。修复：`AgentPresetSeatController` 移除 `developerTools` 参数与 `selectionAvailable()` 持续门控，`clearStage()` 公开为「丢弃未应用选择」操作，transition 清理上移到 `developerTools.enabled` 订阅（显式 clearStage 后 apply 重推显示项）；`load()` 仅在 roster `modeSelectionEnabled` false 时丢 stage。有意分歧保留：上游 `requiresCodingTools` 逐项过滤（chip 关时常显、仅滤 ptc/minimal）与 `reconcileCodingTools`（隐藏默认回退 standard）属上游四表面架构的 per-option 门控，本地为「Show coding view」整体隐藏 chip 的单偏好设计，不引入 | `packages/client/ui-agent-preset`（seat-store.ts/index.ts + apply/settings-store spec + 双语 README)；本地 `fae94360751` |
验证：`deepseek-llm-api-extensions` + `llm-deepseek` 17 测试、`session-log-deepseek` 34 测试、`ptc-runtime-python` 325 测试、`subprocess-local` 359 测试、`session-format-v3-to-v4` 43 测试、`apiproxy` session-export 43 测试、`tool-jobs`/`goal`/`plan`/`agent-team`/`terminal-controller`/`ssh` 799 测试全过；typecheck 干净；`verify-package-dependencies` 门禁（63 包）与其 44 spec 测试通过；`ptc-python-turn` 快照回放通过；`user-questions` 65 测试（排队回复保留、仅录取结算、PTC 子调用 fold）；`client-runtime` 105 定点测试（回显退役/边界/基线/移动 splice）+ `ui-conversation` 定点测试（QueueDock 抑制、回显挂载、steering 去重）；`schedule` + `ui-schedule` 1626 测试（服务/工具/UI 三层 subagent 归属拒绝）；`app-boot`+`plugin-manager`+`hmr` 6092 测试（解析替换移除语义、`computeLatestResolution` 不保留合成层、17 个 package-reload 用例覆盖 install/enable/disable/remove 的发布次序与无 HMR 保留）；`session-telemetry-otel` 73 测试（deadline 销毁在途连接、正常关闭释放 keepAlive）；`apps/cli` plugin 22 测试 + `plugin-compatibility.expected.e2e` 真实 pnpm 验收（拒绝→`allow-version --accept-risk` 授权→安装启动放行→`revoke-version` 恢复拒绝）；`ui-agent-preset` 212 测试（Creator stage 偏好关时落地 + 关断转换清场重推显示）；`runtime`/`ui-schedule` 284 定点测试。决策记录：`.agents/notes/implemented/bug-fix/2026-10-12-deepseek-request-extension-resilience.md`、`2026-10-12-python-ptc-shared-sandbox-policy.md`、`2026-10-12-durable-path-safety-fixes.md`、`2026-10-12-session-reliability-fixes.md`、`2026-10-13-input-echo-admission-ownership.md`、`2026-10-13-schedule-subagent-ownership.md`、`2026-10-13-telemetry-abortable-transport.md`、`architecture/2026-10-13-profile-package-refresh-and-manifest-invalidation.md`、`feature/2026-10-14-cli-version-exemption-commands.md`、`bug-fix/2026-10-14-blank-session-header-corner.md`、`bug-fix/2026-10-14-preset-stage-outlives-tools-toggle.md`。

## 待修缺口（按严重度，源码复核确认）

### P1 — 正确性/安全/挂起

| 缺口 | 本地位置 | 上游参照 |
|---|---|---|
| ~~telemetry 关闭不取消在途 export，`Promise.race` 超时后 transport 仍挂~~ — 已修：`trackedAgentFactory` 复刻 SDK 的 agentFactory 选择并登记每个 agent，`shutdown()` finally 在到期或正常完成两种结局下销毁全部（到期使在途请求直接失败、正常路径释放 SDK 空实现 transport shutdown 留下的 keepAlive socket）；两透传类型同步排除 `selfObsMeterProvider`（上游 `b11af342fe4`） | `packages/session/session-telemetry-otel/src/index.ts`（本地自研：上游 `stopPending` 依附 `dsh-otel` reporter 架构，本树直接组 SDK 管线） | Agent Note `2026-10-13-telemetry-abortable-transport`；本地 `fc2aa3b13a8` |

### P2 — 用户可感知（按根因族）

- plugin-manager/HMR 族：均已移植（见上表：包清单失效 6 提交、解析刷新 4 提交）。两处有意分歧：`RETIRED_BUNDLES`/`dropRetiredBundles` 未移植——本地 `schedule-bundle` 仍在发布、无退休集合，`normalizeShippedProfile` 已覆盖 tuple 退休，退休机制随未来实际退休事件再引入；`package-meta.ts` 的 icon-from-export 演化（`d12257c9597`/`ecedbbc2e6d`/`8339f16c1d5`/`f8a274b76ee`/`b6ef9d55033`/`d68ae3bf510`）属上游 official-catalog 特性族，本地 `readPluginMeta` 已具非阻塞 `error` 诊断语义，该族随 official catalog 一并决策。
- 单点：标题保留、无 key 模型隐藏、agent-instructions 组保护/去重提升、`useConptyDll` 均已移植（见上表）。
- 子代理结算通知不携带 `structured`/`diagnostic`：我们 `ActivationTerminal` 只有 `stopReason`+`output`，带 outputSchema 的可继续子级的结构化结果不会送达父级（上游 `a1da7bcfb96` 的另一半，需扩展 terminal 类型+observer 捕获，非机械移植）。
- ~~CLI：`dsh plugin allow-version`/`revoke-version`/`version-exemptions` 死路指引~~ — 已修：CLI 命令面补齐（见上表 `2c676339904` CLI 面等三提交），拒绝诊断打印的命令可实际执行；豁免持久化于 profile 自有 `compatibility.json`，与包操作共享写锁。
- ~~客户端：空白会话隐藏整个 header~~ — 已修：corner 槽位移出 blank-chrome 守卫（上游契约：blank 时仅隐藏标题/标签/utilities,corner 存活）;`ui-sidebar-right` 的 `BlankExpandButton`/`conversation.input.left` 绕行注册删除（否则同一控件渲染两处）。
- ~~客户端：Coding Tools 关时 Creator stage 静默丢弃~~ — 已修：门控从 apply 时点改为关断转换时清空（见上表）；preset 拒绝无 toast；trajectory 请求生命周期与重试错误；`@` 会话引用按 createdAt 排序；provider 卡缺 `derivedCredential`（`bf0db65bb0e`，`packages/client/ui-settings-models`）；plan 文档无 preview/sidebar/持久卡；`openChildAside` 缺子会话侧栏；Tooltip 被 `.composerSeat` stacking context 压层（QueueDock/GoalBar 未传 portal）；设置面板遇 onboarding 遮罩仍可交互（`7dfad907488`）；未命名会话显示目录名而非"未命名"（`a4ac7e9eb36`/`bcf0ba45cb0`）。
- Markdown/工具呈现：无 CodeToolbar/CodeCard（wrap 切换+复制+lang）；markdown 图片链接无 hover/内联预览；web-fetch 折叠 URL 不可点；审批面板无 `displayReason` 投影；`developer/message` 工具更新通知不渲染。
- 其他：队列行内编辑单行 input 吞换行；`openTarget()` 缺 fs roundtrip 验证；telemetry record 无字节界。

### P3 — 视觉/性能/文案（归族）

焦点环族（~11 处局部 `brand-primary` 残存、侧栏/头部控件环被 `overflow:hidden` 裁剪、Menu refocus 仍画环、Switch off/disabled 不分）；术语族（`ui-subagent` zh"子代理" vs workspace"子智能体"、plan chip warn 色、anthropic baseURL 占位符、`ui-settings-plugins`/`ui-agent-preset` 术语混用）；`.titleRow` 缺 `container-type` 导致 `@container` 折叠规则全死（功能 bug 非风格）；boot 导入错误详情不记；selectModel 同步等落盘；`tokenizeMaxLineLength` 缺失；ContextMeter 空占位；spill 诊断误导；unnamed 搜索误配目录名；Menu 子菜单折叠与首行分隔线；composer model-selection 动态测量等约 30 项。

## P0 — 裁决项：workingDirectory 全栈（上游 0.2.1-alpha.1 新增）

上游新增 `session/working-directory` + `session/tool-working-directory` 正式包：`working-directory/change` 事件、投影、prompt 段、模型可改工作目录的工具、约 20 个消费面接线。本地全树零引用，所有执行面锁死 `header.cwd`。属"是否采纳上游新能力"的裁决项，且是上游 worktree/claude-code-mods 地基。建议独立立项，不混入缺陷修复批。

## 有意分歧（保留本地，非缺口）

- `agentPresets.modeSelectionEnabled` 双门：`projectWritePaths` 使项目级管理员可锁定成员模式选择，上游 devtools 单门会拆掉该 org 管控（组织产品 vs 上游单人产品语义）。
- `reuseWorkspaceBlank`/draftSessions：workspace-first 草稿会话流（apiproxy:4133-4137 自有机制）；上游回退的是其空白会话权限复制 UI，不同物。
- Agent Team 面板 RPC+手动刷新（vs 上游 session projection 推送）：云部署下按需 RPC 省连接；服务层是上游超集（quiet/wakeup/reserveUse/modelSelection/executionAuthority/mailbox 去重）。上游 master direct-inbox 反而弱化，不追。
- `session-log-deepseek` `enabled:false` 默认：隐私立场；上游"设置开关行"单独取（UI 项）。
- subagent external continuable 持久化绑定存储、v4→v7 会话谱系、landlock CI 加固、`.github` 中 ssh-helper/node-addon/release-publish/desktop 工作流、`resolveAccountToken` 死代码（无 account 路由）。

## 待裁决

1. workingDirectory 立项与否（P0）。
2. gateway uplink 双向流是否需要（取决于有无 Remote 消费方）。
3. `reuseWorkspaceBlank` 保留为有意分歧 or 随上游回退。
4. devtools `modeSelectionEnabled` 附加门为有意产品策略（当前结论：保留）。
5. V3→V4 迁移修复范围（本地谱系 v4→v7，旧迁移是否承载生产数据）。
6. 上游 experimental 新包观望：session-search、session-inspector、cot-translation、worktree、claude-code-mods、skill-badge（上游仍在演进，等产品需求或转正）。

## 根治方案（防再次漂移）

1. 每修一族，把上游 commit sha + 本地修复 commit 写入对齐矩阵对应行并转 `verified-ported`；确认分歧的行转 `verified-divergent` 并写理由。
2. `verify-upgrade-records` 加硬门：pending 行不得进 master（或按窗口限期清零）。
3. 移植 4 个轻量校验 gate：`verify-cli-help`、`verify-plugin-record-callers`、`verify-product-use`、`approval-policy`。
