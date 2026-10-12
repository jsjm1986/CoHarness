# 上游对齐审计 — dsh-v0.2.1-alpha.2

## 审计范围与方法

- 目标基线：`dsh-v0.2.0-rc.2`（`c1b47e41fcd`）；演进面：`rc.2 → master HEAD(0.2.1-alpha.2, d7432673886)`。本地检出 `/tmp/dsh-upstream-rc2` 与 `/tmp/dsh-upstream-master`；fork 与上游无共同祖先，全部结论基于逐文件源码与提交 diff 核对，不凭包名或提交标题推断。
- 覆盖：283 个共享包 + 上游 33 独有包；约 272 个上游提交逐个核对（0.1.7 系列 110 个 PRE 窗口 + rc.1→master 162 个 fix/perf/client）；工具/config/persistence 三份生成式 catalog 均为最新且语义一致；system prompt 快照比对无模型可见差异。
- 主权清单 `scripts/upstream-sync.json`：317 包（adapted 222 / tracked 58 / owned 35 / replaced 2）；tracked 层抽查逐字一致。对齐矩阵 359 行中 322 行仍为 `pending-cumulative-source-review`——本次漂移根因，根治项见末节。
- 结论分级：P0 架构级 / P1 正确性·安全·挂起 / P2 用户可感知 / P3 视觉·性能·文案；并区分 `N/A-DIVERGENT`（有意分歧）与 `N/A-EXCLUDED`（不携带包系）。

## 已移植（2026-10-12，本批）

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

验证：`deepseek-llm-api-extensions` + `llm-deepseek` 17 测试、`session-log-deepseek` 34 测试、`ptc-runtime-python` 325 测试、`subprocess-local` 359 测试、`session-format-v3-to-v4` 43 测试、`apiproxy` session-export 43 测试、`tool-jobs`/`goal`/`plan`/`agent-team`/`terminal-controller`/`ssh` 799 测试全过；typecheck 干净；`verify-package-dependencies` 门禁（63 包）与其 44 spec 测试通过；`ptc-python-turn` 快照回放通过。决策记录：`.agents/notes/implemented/bug-fix/2026-10-12-deepseek-request-extension-resilience.md`、`2026-10-12-python-ptc-shared-sandbox-policy.md`、`2026-10-12-durable-path-safety-fixes.md`、`2026-10-12-session-reliability-fixes.md`。

## 待修缺口（按严重度，源码复核确认）

### P1 — 正确性/安全/挂起

| 缺口 | 本地位置 | 上游参照 |
|---|---|---|
| telemetry 关闭不取消在途 export，`Promise.race` 超时后 transport 仍挂 | `packages/session/session-telemetry-otel/src/index.ts:283-297` | 上游补丁形态不同，需自研 abortable transport |

### P2 — 用户可感知（按根因族）

- user-question 可靠性：缺 queued reply 追踪/跨客户端恢复/重复应答去重/延迟 settle（`packages/interaction/user-questions`）。
- 输入回显生命周期：canceled inbox splice 不退休 steering echo、dispose 把已录取 echo 报 failed、transcript echo 不等 inbox 水位（`packages/runtime/sessions/session.ts:1209-1241`、`:873-875`）。
- schedule/subagent 归属：创建/更新不拒子代理会话、工具不拒 delegated child、无 typed result。
- plugin-manager/HMR 族：未装 bundle 不可移除、meta 解析失败阻塞请求、retired schedule 残留 manifest、清单无 version 不降级、install/enable/remove 不刷新解析表；package.json 变不失效 cache、缺 CJS `_load` hook。
- 单点：标题不保留既有合适标题；无 key 模型不隐藏；agent-instructions 失败不上报；Windows `useConptyDll` 未启用。
- 子代理结算通知不携带 `structured`/`diagnostic`：我们 `ActivationTerminal` 只有 `stopReason`+`output`，带 outputSchema 的可继续子级的结构化结果不会送达父级（上游 `a1da7bcfb96` 的另一半，需扩展 terminal 类型+observer 捕获，非机械移植）。
- CLI：`dsh plugin allow-version`/`revoke-version`/`version-exemptions` 未实现，但 `packages/boot/app-boot/src/plugin-compatibility.ts:101` 的错误提示指引用户运行它（死路指引）。
- 客户端：空白会话隐藏整个 header；Coding Tools 关时 Creator stage 静默丢弃；preset 拒绝无 toast；trajectory 请求生命周期与重试错误；`@` 会话引用按 createdAt 排序；provider 卡缺 `derivedCredential`（`bf0db65bb0e`，`packages/client/ui-settings-models`）；plan 文档无 preview/sidebar/持久卡；`openChildAside` 缺子会话侧栏；Tooltip 被 `.composerSeat` stacking context 压层（QueueDock/GoalBar 未传 portal）；设置面板遇 onboarding 遮罩仍可交互（`7dfad907488`）；未命名会话显示目录名而非"未命名"（`a4ac7e9eb36`/`bcf0ba45cb0`）。
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
