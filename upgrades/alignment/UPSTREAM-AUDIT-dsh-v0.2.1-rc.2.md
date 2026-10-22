# CoHarness → dsh-v0.2.1-rc.2 独立复核

## 结论与固定范围

当前候选尚未达到发布级收口。复核发现了可复现的数据丢失、关闭期错误、产物构建阻断，以及此前升级遗留的功能、验证和记录欠账。先前“rc.2 全量收口完成”的结论不成立。

- 本地代码：`feat/upstream-sync-batch2`，`afc4bf40751cb7451c96b33a10b9c3bc62ceca73`。
- 上游目标：[`dsh-v0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)，`687f282e8625c6b8d11ff58211a90524be2e4317`。
- 审查分两批覆盖运行时、客户端、构建发布、历史记录与测试证据，并交叉检查疑似问题；并发不超过五个审查任务。
- [证据附件](UPSTREAM-AUDIT-dsh-v0.2.1-rc.2.json)保存官方发布说明原文、来源 URL、tag commit、正文 SHA-256、逐条文本位置、命令结果摘要、日志哈希和临时复现代码。

本报告区分实跑失败、源码确认的差异、产品决策冲突和未验证项。发布说明清点与源码检查不等于每个产品行为已经验收；性能、平台和生产验证仍有明确限制。没有将尚待复核的矩阵行批量标记为完成。

## 发布说明覆盖

捕获并校对了 31 份 DSH 发布说明。每个 tag 的本地 commit 与远端公布的 tag commit 一致。共提取 838 条中文条目出现次数，保留累计发布说明中的重复条目；这个数字不是独立能力数或验收通过数。英文原文也保存在附件中。正文哈希针对 GitHub API 的原始 UTF-8 正文，临时 Markdown 阅读副本仅另加一个末尾换行。

| 发布 | 中文条目数 | 发布 | 中文条目数 |
| --- | ---: | --- | ---: |
| 0.1.0-rc.7 | 12 | 0.1.0-rc.8 | 14 |
| 0.1.1-rc.1 | 5 | 0.1.1-rc.2 | 2 |
| 0.1.2-alpha.1 | 52 | 0.1.2-alpha.2 | 16 |
| 0.1.2-alpha.3 | 9 | 0.1.2-alpha.4 | 8 |
| 0.1.2-alpha.5 | 1 | 0.1.2-rc.1 | 71 |
| 0.1.3-alpha.1 | 19 | 0.1.3-alpha.2 | 16 |
| 0.1.5-alpha.1 | 15 | 0.1.5-alpha.2 | 15 |
| 0.1.5-rc.1 | 51 | 0.1.5-rc.2 | 2 |
| 0.1.6-alpha.1 | 44 | 0.1.6-alpha.2 | 29 |
| 0.1.7-alpha.1 | 61 | 0.1.7-alpha.2 | 15 |
| 0.1.7-rc.1 | 90 | 0.1.7-rc.2 | 42 |
| 0.2.0-rc.1 | 19 | 0.2.0-rc.2 | 16 |
| 0.2.1-alpha.1 | 25 | 0.2.1-alpha.2 | 43 |
| 0.2.1-alpha.3 | 29 | 0.2.1-alpha.4 | 8 |
| 0.2.1-alpha.5 | 5 | 0.2.1-rc.1 | 102 |
| 0.2.1-rc.2 | 2 | | |

前 28 份说明的 729 条与[alpha.4 旧台账](UPSTREAM-RELEASE-NOTES-LEDGER-dsh-v0.2.1-alpha.4.json)逐发布数量相符。旧台账包含早期版本和累计版本，缺少单独的每-tag manifest 本身不证明漏移植。旧台账的 Y/N/P/R/X 结论需要按当前代码复核；本轮同时发现了错误的“已有”“未携带”和“不适用”。

## 实跑确认的问题

### JSONL 存储插件卸载丢失最后事件

上游 `4d9047be2d03710e3e4cfce576bc397389c4be67` 修复了 provider 触发卸载时的资源存活顺序，发布说明见 0.2.1-alpha.3 和 rc.1。本地 [JSONL provider](../../packages/session/session-persistence-jsonl/src/index.ts) L241–292 将服务与 tracker 注册在同一 fiber；[tracker](../../packages/session/session-persistence-jsonl/src/storage.ts) L543–574 独立注册事件监听和关闭 handle 的清理；Cordis 并发执行这些独立清理。

临时复现保留一个异步清理的依赖消费者，只卸载 provider，待消费者追加 `turn/end` 后读取实际文件。结果为 `listenerCountDuringConsumerTeardown: 0`，内存事件 `["turn/start","turn/end"]`，磁盘记录 `["session","turn/start"]`。最后事件确实未落盘。SQLite/Gateway 使用的协调器没有覆盖这个 JSONL 路径。修复需要保证消费者完成清理后才撤销 tracker 和 writer。

### 凭据 watcher 关闭后漏接迟到错误

[credentials-local](../../packages/credentials/credentials-local/src/index.ts) L616–625 在 `watcher.close()` 后没有重新保留错误处理器。上游 `df41b7cd2de` 已处理 Chokidar 关闭时移除监听器、写入稳定性轮询随后继续报错的情况。

按真实 Chokidar 关闭语义构造的确定性 mock 在关闭时移除监听器，随后发出 `EPERM`。复现得到 `errorListenersAfterClose: 0`，错误向外抛出，安全断言失败。这证明关闭期处理缺口；它不是一次原生 Windows 文件系统竞态验收。

### SSH helper 有两处独立构建阻断

[Linux 工作流](../../.github/workflows/build-exe-for-ssh-helper.yml) L93–95 调用不存在的 `scripts/prepare-linux-node-pty.sh`，实际命令退出 127。上游目标包含这个 manylinux PTY 构建脚本，本地 `079462b5208` 携带工作流时遗漏了它。

此外，[SSH carrier](../../packages/ssh/ssh-helper-runtime/package.json) 没有补齐 fork 特有的必需 peer：`dsh-session → dsh-session-format` 与 `dsh-ssh → dsh-credentials`。[构建器](../../scripts/build-exe-for-ssh-helper.ts) L118–123 在编译及 dry-run 返回前检查闭包。macOS arm64 的 `--dry-run` 已退出 1 并准确列出这两条链；相同检查适用于四个目标。只恢复 Linux 脚本不能解除整个阻断。

### Python SDK 缺少 Schedule 依赖闭包

`3bd8b04bf09` 给 standard、cordis、ptc 预设加入 `dsh-tool-schedule`，也更新了 CLI 依赖，却遗漏了 [Python carrier](../../python/sdk-runtime/package.json)。`verify-runtime-closure` 在三个预设、五个平台目标上全部报告缺包。

修复需同时核对 `dsh-tool-schedule` 和 `dsh-schedule`：前者的 [package.json](../../packages/schedule/tool-schedule/package.json) L32 声明后者为必需 peer，源码也有运行时导入。服务默认 opt-in 不会取消模块加载依赖。工作区源码构建通过不能替代部署闭包检查。

### 四个公开包破坏本地发布版本一致性

`claude-code-mods`、`client-ui-claude-code-mods`、`agent-preset`、`tool-schedule` 保留了上游 `0.2.1-rc.2`，其余发布成员使用本地 `0.1.5-alpha.1.coharness.1`。[发布族检查](../../scripts/release/families.ts) L347–353 实跑退出 1。引入提交分别为 `10cff3fb193`、`8a6aa525882`、`3bd8b04bf09`。

[bump 流程](../../scripts/release/bump.ts) 在规划新版本前也检查现有版本一致性，所以普通后续 bump 不能自动修复这个状态。应先恢复本地发布族的一致性，再按正式发布决定更新版本；本问题不要求 fork 使用与上游相同的版本号。

### Python runtime 同步步骤破坏相对别名

主运行时准备与安装已经保留相对 Python alias，但 [SDK 同步步骤](../../scripts/build-exe-for-python-sdk.ts) L518–520 仍使用 `cp(path, destination, { recursive: true })`。隔离实验复现了完全相同的复制选项：`python3 → python3.12` 被改成指向 `dist-exe` 源目录的绝对链接；删除源目录后，复制结果读取失败。

上游 `cbaefed0577` 的资源复制使用 `verbatimSymlinks: true`，并带重定位回归。当前确认范围是同步到 Python runtime 的开发/可编辑 carrier；[wheel 构建](../../scripts/build-python-release.py) 有不同的复制行为，不能据此断言所有 wheel 都损坏。

### Schedule 浏览器复演仍采用旧测试组装

真实执行 `DSH_SNAPSHOT=replay` 的 [schedule-after.e2e.ts](../../apps/web/tests/schedule-after.e2e.ts) 得到 4 通过、4 因 suite 初始化失败而跳过，退出 1。L308–325 直接创建 Agent，没有为它挂载预设，随后调用 `schedule_create` 失败。上游对应测试已在 Agent `setup` 中调用 preset mount。

这是工具拆分后漏迁测试消费者的证据。产品 [ApiProxy](../../packages/host/apiproxy/src/api-proxy.ts) L2489–2494、L3430–3440 确实挂载预设，因此本次失败不能证明正常 Web 会话中的 Schedule 一概不可用。此测试默认无密钥；此前“需要 key，故未验证”的解释应撤回。

## 源码确认的剩余差异

以下条目已沿当前调用路径与上游实现交叉核对；没有把源码证据写成对应平台或浏览器场景的实跑通过。

| 问题 | 证据与影响 | 上游来源 / 验证要求 |
| --- | --- | --- |
| SEA 原生资源解包的并发写入修复缺失 | [pkg patch](../../patches/@yao-pkg__pkg@6.21.0.patch) 缺少原子发布部分；已安装依赖仍直接 `writeFileSync` 到共享原生缓存。Python 和 SSH 构建器都实际使用 SEA。旧台账把它记为“pkg/SEA 打包，不适用”不成立。 | `5992977f2ee`，0.1.7-alpha.1。需要原生并发冷启动复验，当前未声称复现 SIGBUS。 |
| Python executable 漏打包插件图标 | [资产选择](../../scripts/build-exe-for-python-sdk.ts) L46–69 未覆盖包内通用 svg/png 等；可达的 schedule-bundle 等声明了 icon，元数据读取会产生错误。 | `d68ae3bf510`；需在实际 executable 中读取插件元信息。 |
| 依赖更新未全部吸收 | 当前解析仍含 MCP client/server 2.0.0、MCP SDK 1.30.0、sharp 0.35.3；[lockfile](../../pnpm-lock.yaml) 与运行时依赖一致。上游对应目标为 2.2.0、1.31.0、0.35.5。 | `1150a874fc7`，0.2.1-alpha.2/rc.1。这是更新欠账，没有据版本号推断具体漏洞可利用性。 |
| Trajectory 缺少普通 durable 图片预览 | [layout](../../packages/client/ui-trajectory/src/client/layout.ts) L838–888 将 attachment 图片变成 JSON，图片解析只接受 URL/base64；[渲染器](../../packages/client/ui-trajectory/src/client/TrajectoryTable.tsx) L1176、L1448 只在有 `imageSrc` 时显示图片。 | `c27de594fd5` / #3009，0.1.2-alpha.1。需分别覆盖用户、助手和工具结果图片。 |
| 已发送文件/Skill 引用无法点击预览 | [MessageItem](../../packages/client/ui-conversation/src/client/chat/MessageItem.tsx) L188 把导航参数传为 `undefined`；[projectUserText](../../packages/client/ui-primitives/src/user-text.tsx) L168–185 因而渲染无动作的 span。 | `8d1e8acdec3` / #3917，0.1.6-alpha.1。不能用 helper 有可选回调来证明产品已经接线。 |
| 刷新浏览器后草稿引用失去结构 | [store](../../packages/client/ui-conversation/src/client/stores.ts) 保存字符串；[facade](../../packages/client/ui-conversation/src/client/input/facade.ts) L715–718 持久化 clipboard 文本，重载走字符串恢复。跨 Workspace 的结构化 carry 已实现，浏览器刷新没有覆盖。 | `e400349e3a4` / #5505，0.2.1-alpha.1。规范化引用文本仍保留；未发现引用 ID 丢失的证据。需验证 chip/原子编辑恢复。 |
| active-but-disarmed 目标缺少正确的恢复按钮 | [GoalBar](../../packages/client/ui-goal/src/client/GoalBar.tsx) L130–143 仅按 durable phase 选按钮，active 一律 Pause。运行时支持 active/disarmed 恢复，Remote 已转发 activation 事件，GUI 尚无消费者。 | `66ac8cc094e` / #3485，0.1.5-alpha.1/rc.1。`/goal resume` 仍可用；[README](../../packages/client/ui-goal/README.md) L18 与 L39 自相矛盾。 |
| 自定义 provider 表单未校验/规范化 Base URL | [CustomProviderCard](../../packages/client/ui-settings-models/src/client/CustomProviderCard.tsx) L123–125 只要求非空，L149–162 提交原值，L283–291 传原值做发现。配置解析也只拒绝空串。 | `cad50c2504e` / #3792，0.1.5-alpha.2/rc.1。共享 discovery helper 已验证 HTTP(S)，但创建路径和即时错误提示仍缺失；应验证非法 URL 零 mutation/discovery 调用。 |

## 历史默认值与决策冲突

这些差异需要先核对当前产品决定，不能机械追随上游，也不能依据相互冲突的旧记录直接回退。以下五项冲突已在本轮取得 owner 裁决并落地；条目标注 **裁决→** 记录现行决定。

- **Web minimal。** **裁决→** web minimal 与 SDK minimal 对齐为仅持久 Shell；fs-local 与 str_replace_editor 改为显式启用项。预设文件与相关金样已同步更新，[8 月 10 日笔记](../../.agents/notes/implemented/simplification/2026-08-10-default-presets-single-editor.md) 的现行状态陈述已校正并交叉链接。对应上游 `63795eaa5cb` / #3510。
- **Ralph。** **裁决→** 默认关闭、显式启用，与上游 `73985344cda` / #4101 和 [workflow 笔记](../../.agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.md) 的记录一致；base bundle、standard/cordis/ptc 预设均已置 `disabled: true`，示例 overlay 保留显式 opt-in，ralph 专用回放金样仍通过以证明 opt-in 路径可用。
- **Bash justification。** **裁决→** 显式传入空白 justification 一律拒绝；省略参数的普通执行不受影响，扩大权限必须提供非空理由。[tool-bash](../../packages/shell/tool-bash/src/index.ts) 的重复模式提前返回保留省略豁免，但显式 justification 仍进 `validateEscalationArgs`；pwsh 已对齐同一语义。`7358cc3b9c2` 带入的相反记录按本裁决更新。
- **Jobs wake budget。** **裁决→** 维持默认不限：`maxConsecutiveWakes` 不设默认上限、保持可选配置，确认 `d391a6f756b` 与[后续决策](../../.agents/notes/implemented/bug-fix/2026-10-12-session-reliability-fixes.md)。[矩阵生成器](../../scripts/gen-upstream-alignment-matrix.ts) 中残留的旧“上界 10”文案已改为 unset = no cap。
- **凭据优先级。** **裁决→** 维持 env-first，确认[本地治理决定](../../.agents/notes/implemented/architecture/2026-08-04-credentials-yaml-and-user-environment-layer.md)；上游 GUI saved-first/headless env-only 为有意分歧，见下文指南处置表 `stored-credentials-precedence` 行。

## 升级指南处置与本轮裁决

上游 v0.2.1-alpha.1–alpha.4 共 34 篇升级指南三件套；此前 fork 已发布 5 篇，本轮对剩余 29 篇逐篇对照当前代码核定处置：**15 篇已回填发布**（其中 `deepseek-model-discovery`、`pi-ai-model-discovery`、`new-session-generations`、`job-id-identity`、`working-directory` 五篇按 fork 实况改写——无 Desktop 应用面、`job/registered|settled` 事件未携带、`{{cwd}}` 保留），**14 篇登记为不发布**：排除范围 5（Desktop/账号锁定面）、未携带 6、已裁决不发布 3。逐篇处置表（本仓库内固定，替代曾引用的未持久化日志）：

| 指南 | 处置 | 依据 |
| --- | --- | --- |
| `deepseek-model-discovery` (alpha.1) | 回填（改写） | 缺凭据返回空目录已携带；无 Desktop 应用面 |
| `job-id-identity` (alpha.1) | 回填（改写） | 本节裁决表；`job/registered|settled`/`executionId` 未携带 |
| `jsonl-persistence-plugin` (alpha.1) | 回填 | session-persistence-jsonl 承载 |
| `new-session-generations` (alpha.1) | 回填（改写） | 本节裁决表 |
| `plugin-option-placement` (alpha.1) | 回填 | 本节裁决表 |
| `python-ptc-sandbox` (alpha.1) | 回填 | ptc-runtime-python 承载 |
| `session-title-adapters` (alpha.1) | 回填 | 本节裁决表 |
| `session-title-provider-strategy` (alpha.1) | 回填 | 本节裁决表 |
| `terminal-command-labels` (alpha.1) | 回填 | terminal 命令标签已携带 |
| `web-listener-trust-config` (alpha.1) | 回填 | web listener 信任配置已携带 |
| `working-directory` (alpha.1) | 回填（改写） | `{{cwd}}` 语义保留 |
| `from-default-profile-replaces-target` (alpha.2) | 回填 | profile 目标替换语义已携带 |
| `pi-ai-model-discovery` (alpha.2) | 回填（改写） | 本节裁决表 |
| `plugin-install-over-installed` (alpha.2) | 回填 | plugin install 覆盖已装行为已携带 |
| `plugin-engines-dsh` (alpha.3) | 回填 | dsh 引擎面已携带 |
| `desktop-test-auth-popup` (alpha.1) | 不发布 | 排除面：Desktop 锁定范围 |
| `deepseek-account-identity-watch` (alpha.2) | 不发布 | 排除面：账号链锁定范围 |
| `deepseek-account-model-catalog` (alpha.2) | 不发布 | 排除面：账号链锁定范围 |
| `desktop-font-size-shortcuts` (alpha.2) | 不发布 | 排除面：Desktop 锁定范围 |
| `account-notification-fields` (alpha.4) | 不发布 | 排除面：账号链锁定范围 |
| `mock-messages-events` (alpha.1) | 不发布 | 未携带：本地 mock server 只发无名 SSE（见下） |
| `subagent-activations` (alpha.1) | 不发布 | 未携带：托管激活子代理模型整体未携带（见下） |
| `team-direct-inbox` (alpha.1) | 不发布 | 未携带：`targetInbox`/direct-inbox 面无对应实现 |
| `native-subagent-bundle-tools` (alpha.1) | 不发布 | 未携带：subagent bundle 全局工具面无对应实现 |
| `python-optional-resources` (alpha.1) | 不发布 | 未携带：可选 Python 资源显式下载面无对应实现 |
| `experimental-package-composition` (alpha.1) | 不发布 | 未携带：可选能力显式安装/组合面无对应实现 |
| `operator-connect` (alpha.2) | 不发布 | 已裁决：行为经 fork 自有接缝实现（下表），上游 `/connect`+Cookie 文本不适用 |
| `sdk-minimal-image-compaction` (alpha.2) | 不发布 | 已裁决：sdk-minimal 仅 Shell 为有意分歧（minimal 裁决） |
| `stored-credentials-precedence` (alpha.2) | 不发布 | 已裁决：凭据 env-first 维持（历史冲突节） |

未携带六篇若后续移植，指南三件套随行为一并回填。

## 插件管理面重裁决（owner 指令 2026-10-18）

**指令**：同步上游更新的全部插件功能（含中英文双语说明），保持 fork 现有插件管理模式（`gateway/admin-ui` 管理控制台 + `ui-plugin-manager` 侧栏面板）与二开能力不变——上游内容移植进 fork 架构，不替换 fork 面。

**裁决复审**：经截图比对确认 fork 缺失的是呈现层与部分能力本体，此前按包粒度的 reject/defer 逐条重审：

| 行 | 原裁决 | 重裁决 | 依据 |
| --- | --- | --- | --- |
| `ui-plugin-manager` 增量（策展橱窗 `EXTENSION_BUNDLES`/`MORE_BUNDLES`、预览 SVG、`sanitize-install-input`） | adapt/pending | **移植** | fork 同名包缺整段橱窗；`setEnabled` profile-layer 机制两边一致，直接移植；`productAnalytics` 为排除面丢弃 |
| `ui-settings-plugin-inventory` | reject | **改判=移植** | owner 覆盖"重复"理由：只读 Loader 清单视图作为独立面挂入 fork 设置体系 |
| `cot-translation-bundle`+`client-ui-cot-translation` | defer（账号面阻塞） | **移植** | translator `provider: bing` 为非账号可插拔通道，阻塞不成立 |
| `inspector-profile`+`inspector`+`session-inspector` | defer/reject（session-controller 面阻塞） | **移植** | fork `client/runtime`+`api/remotes` 接缝映射上游 session-controller 读取面 |
| `session-search` | reject | **移植包装层** | `session-query*` 三包已在 fork（web-app 已默认编入）；补 bundle 供非 web profile 选用 |
| `session-titles-bundle`/`terminal-bundle`/`badge-skill-bundle`/`ralph-bundle` | reject（包装未携带） | **移植包装层** | 能力本体已在（session-title-llm/terminal/skill-badge/tool-ralph）；包装是橱窗开关的落点，随橱窗移植成立 |
| 上游设置分区包 `ui-settings-{agent-loop,session-log,shell,subagent,web-search}` | reject | **维持 reject，补内容核对** | fork 表单卡已承载语义；本轮增量审查补上游新增字段/文案到 fork 卡内，分区包结构不引入 |
| fork 独有实验面 | — | **保留并入橱窗** | schedule-bundle 等带 locale+icon 的 fork 自有 bundle 追加进橱窗 fork-extras 段 |

回填核查另暴露三处需记录的真实差距：上游托管激活子代理模型整体未携带（fork 保留前后台委派与 `subagent-in-process-driver`）；`sdk-minimal` 无 fs 工具与自动 compaction——即上文 shell-only minimal 裁决的有意分歧，非遗漏；本地 mock server 只发无名 SSE，期待命名事件的原生 SDK 消费方会失败（`llm-mock-server/src/index.ts:322` 附近）。

| 指南 | 裁决 | 落点与证据 |
| --- | --- | --- |
| `job-id-identity` (alpha.1) | **已实现**（`e493fd40dcfa` 移植） | `LocalJobRegistry.start` 铸 `<kind>-<16hex>`（`randomUUID` + 碰撞重试），进程内计数器移除；fork 无 `executionId`/持久化 job 生命周期记录，该部分不适用。连带规范化器修正：语料外悬挂会话引用（如 external 子代理的 catalog `childId`）记 `{{id:N}}` 与上游一致——此前 fork 记 `{{session:N}}` 导致 refresh 反复重写不稳定。336/336 快照回放绿。 |
| `plugin-option-placement` (alpha.1) | **本轮实现，已落地** | [args.ts](../../apps/cli/src/args.ts) `plugin` 子命令加 `passThroughOptions()`：仅在 pnpm 参数前读取 `--profile`，之后原样转发；`dsh plugin add <pkg> --profile x` 现转发并报错——有意破坏，树内脚本均为 profile 前置序。指南三件套已回填发布。 |
| `operator-connect` (alpha.2) | **经 fork 自有接缝实现（前提链已启动）** | 上游机制（`/connect` + Peer/Principal + API Cookie + `$events` 端点）位于 fork 主权裁决 `replaced` 面，不移植其实现。fork 等效路径：复用已落地的 [collaboration.authorize](../../packages/context/collaboration/src/types.ts) 接缝——`claimInteraction` 作应答认领后端、连接级 `interactions` 模式、`connection/authenticate` provider 接缝做非 Cookie 令牌接入、BFF `host/remote-event` 帧按连接过滤。主权裁决不推翻，仅扩展其概念移植范围。 |
| `session-title-adapters` + `session-title-provider-strategy` (alpha.1) | **本轮移植，已落地** | [session-title-llm](../../packages/session/session-title-llm/src/index.ts) 已重写：`executeSessionTitleLlm` 经 `ctx.llm.prepareCall`；旧 `registerSessionTitleLlmProvider`/`generateSessionTitleWithLlm`/`SessionTitleLlmMessageSelector` 全删；`SessionTitleLlmConfig` 收敛为执行控制；`session/title-llm-request` 记录所选 effort。两篇指南三件套已回填发布；遗留缺口：上游 `session-title-stability` 快照场景无对应回放（窄证已由单测覆盖）。 |
| `pi-ai-model-discovery` (alpha.2) | **本轮实现，已落地** | [llm-pi-ai adapter](../../packages/llm/llm-pi-ai/src/adapter.ts) `listModels` 先解析 `apiKeyEnv` 凭据：`MISSING_CREDENTIAL` → 空目录（UI 隐藏该组），其它凭据错误照常失败；与已移植的 DeepSeek 侧行为一致。 |
| `new-session-generations` (alpha.1) | **已落地** | [workspaces/service.ts](../../packages/client/runtime/src/client/workspaces/service.ts) 新建一律 `sessions.create({workspaceId})` fresh Session+Agent 取当前预设；`openWorkspace`/`connectWorkspace` 重连保留空会话复用与 draft 预约语义；在途 fresh 创建不被重连复用。client/runtime 593 + gateway 48 测试绿；`draft-initialization` 金样按新契约重录。 |
| `mock-messages-events` 等其余未携带/已差异项 | **按处置表登记** | 各篇以代码证据登记为 carried（回填）/not-carried（登记差异）/excluded-lane（桌面或账号锁定范围，不发布指南）；`stored-credentials-precedence` 记为 env-first 有意分歧。 |

另有一致性修正：pwsh 重复当前沙箱模式的 justification 要求已对齐 fork bash——省略即豁免、显式空白仍拒；上游 bash 无此豁免，此为 fork 有意对称。

## 文档、生成物和验证欠账

完整 `doc-sync` 在冻结代码上是 31 通过、10 失败：

| 失败项 | 已定位内容 |
| --- | --- |
| type equivalence | [type-equiv.manifest.json](../../scripts/type-equiv.manifest.json) L4 起缺对象括号及逗号，另有空对象；`b569ce4f87e` 的删除操作破坏 JSON。 |
| Cordis catalog | [claudeCodeMods 服务](../../packages/experimental/claude-code-mods/src/index.ts) 没有 SERVICE_PAGE 分类。 |
| workflow guest source | [guest-source.ts](../../packages/workflow/workflow-ptc/src/guest-source.ts) 过期。它被 Host 实际执行，不只是文档。 |
| client catalog | [slot-catalog.ts](../../packages/extensions/cordis-client-runner/src/client/slot-catalog.ts) 过期。 |
| config catalog | [配置目录](../../docs/config-catalog.md) 英中生成物过期。 |
| skill plugin package list | [模型可读插件列表](../../apps/cli/config/agent-presets/cordis/skills/cordis-composition-reference/references/packages.md) 过期。 |
| persistence type history | [DeepSeek search 变更](../../docs/persistence-changes/2026-10-13-deepseek-search-thinking.md) 引用了不存在的 `2026-09-11-initial` predecessor。 |
| persistence catalog | [持久化目录](../../docs/persistence-catalog.md) 英中、配对记录和 schema JSON 过期。 |
| package README Model Experience | client-ui-claude-code-mods 与 agent-preset 的说明缺少要求的审查登记。 |
| documentation standard tests | [SSH helper README](../../packages/ssh/ssh-helper-runtime/README.md) 的 kind 为 package-library，当前规范要求 package-reference。 |

审计时还发现三处文档冲突：[subagent 迁移指南](../../docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.md) 将提醒工具归给 dsh-schedule，现已明确 Host 服务与 preset 工具的分工；[use-drivers 同步笔记](../../.agents/notes/implemented/architecture/2026-09-19-upstream-alpha2-use-drivers-sync.md) 需清理已被替代的 invariant、发布策略与验证清单，有界取消的现行语义已在[Auto review 决策](../../.agents/notes/implemented/feature/2026-08-28-auto-review.md)中校正；[Host plane 笔记](../../.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md) 仍需修正旧 invariant 的组装拒绝说明。既有归档的封存内容不变。

TypeScript SDK 还缺少上游 `snapshots/sdk/tool-scheduler-recovery` 对应的组装回放。Python 的 [scheduler-recovery](../../scripts/snapshots/python-sdk-single-exe/scheduler-recovery/requests.json) 和 Headless 回放已存在，但没有覆盖 TypeScript SDK 的通知投影。应按 fork V7 代次补证，不能直接覆盖或导入上游 V4 session 文件。

## 当前台账不能证明验收完成

[矩阵](UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.2.1-rc.2.json) 的 395 个实际 rows 正确分割了 9,323 个累计路径，与原始 `git diff --no-renames` 一致，没有漏路径或多余路径。2026-10-19 全量复核后 395 行全部 `implemented-local-tests-passing`：各行 not-carried 尾部按类归因登记（locale 布局、fork 测试布局、removedUpstreamPaths 登记、排除车道、具名未吸收增量），零携带 adapt 行单独裁决（Makefile 与 `tsconfig.node.base.json` 判 `not-carried`，`api/job-controller` 确认折叠进 `host/apiproxy`+`packages/jobs/jobs` 改记 `carried-adapted`）。具名未吸收上游增量——typert worker/principal 协议件、`settings/schema.ts`、`session-persistence-jsonl/catalog-migration.ts`、`llm-pi-ai/provider-data`、client/modules 发布变更接缝、ui-settings-general HostReleasePrompt——在各行 notes 登记待后续 increment 裁决。嵌套历史状态不能再次计数。

当前主权数为 72 tracked、225 adapted、46 owned、2 replaced、42 upstream-only。tracked 的检查范围是源码，不代表整个包的测试、清单和产物都已对齐。[计划](../plans/UPGRADE-PLAN-dsh-v0.2.1-rc.2.md) 中的 63/219/46/2/57 是旧快照。

[manifest](../manifests/UPGRADE-MANIFEST-dsh-v0.2.1-rc.2.json) 的 schedule preset、Python alias、NumPy/pandas 测试剔除、UI 市场策略复核四项维持 `deferred-platform-review`；`subpath-plugin-display-manifest` 已于 2026-10-19 复核翻篇为 `adapt`+`implemented-local-tests-passing`（subpath 名解析 `parts.slice(0, name.startsWith("@") ? 2 : 1)` 两边逐字一致，残余差异仅在被排除的 official-bundle/on-demand 字段）。源码能力已存在，不代表上述打包、复制和组装遗漏也已解决。

rc.2 提交 inventory 已生成（`UPSTREAM-COMMIT-INVENTORY-dsh-v0.2.1-rc.2.json`，1622 commits，targetCommit `687f282e`）。路径全覆盖不能证明每个提交意图都得到审查，尤其是累计 diff 中不再出现的中间增删；本轮按行复核即以逐行源码证据补齐该语义层，而非把生成后的 pending 改名。

`verify-upgrade-records` 本来就允许显式 pending，检查通过符合其职责。[release readiness](../../scripts/release/readiness.ts) 要求被接受的 reviewState 和排除证据；矩阵复核翻篇后 reviewState 一项已满足，其余要求见下节终验表。

**本节状况已消除**：manifest 已落到终态——24 条决策均有 commitScope/notes，`job-id-identity` 与其余六项移植均记 `adapt`+`implemented-local-tests-passing`，四项平台延期维持 `deferred-platform-review`，`subpath-plugin-display-manifest` 复核后翻篇；主权数已更新为 72/225/46/2/42；矩阵 395 行全部 `implemented-local-tests-passing`，具名未吸收增量按行登记。

[alpha.2 验收台账](UPSTREAM-AUDIT-dsh-v0.1.6-alpha.2.md) 和[验收运行手册](ACCEPTANCE-RUNBOOK.md) 仍留有真实 provider、多平台、双用户、生产恢复等未验收证据。旧记录中的局部通过不能移作当前 HEAD 的整体验收。本轮查询 GitHub 没有得到此 HEAD 的 Actions run，也没有得到此本地分支的 PR；这不推断其他分支的状态。

## 已纠正的误报

- **密钥脱敏已集成。** `acb1b49584a` 将 scanner/mask/SecretText 放入 ui-primitives，MessageItem 调用已接线；默认遮罩与按需显示存在，相关选定测试通过。`ui-secret-mask` 包未携带与功能未携带是两回事。当前 defer 理由应改成集成式实现的证据。
- **重连、Inbox 恢复、Worktree 已有实现。** 当前连接对象包含 backoff/handshake deadline；Inbox 使用持久 fold 与冷会话投影；Worktree 及旧 Git 修复已携带。缺少上游同名文件或 controller 不构成遗漏。
- **模型输入类型与模型发现已有等效实现。** UI 可选择 image 输入，发现逻辑已集中到共享 LLM helper；旧组件或文件名不再适合作为存在性判据。
- **历史 Messages/子代理兼容修复已有承载。** 序列化过滤、进程相关 prompt 处理及 fork 的 V3→V4、V6→V7 迁移各有实际落点。此前仅凭 translate 文件没有 legacy 关键词提出的缺口不成立。
- **凭据额外字段容忍范围一致。** 上游和 fork 都容忍未知顶层字段，同时拒绝未知记录字段；不能把后者泛化成遗漏该修复。
- **两种 primary-runtime manifest 属独立 carrier。** 当前读写者配对成立，两个 lock 文件也相同；没有找到自动误投另一种 reader 的路径。
- **旧 gate replay SHA 不自动失效。** 校验器允许相同 blob 的祖先审查。缺少 `verify-v3-event-vocabulary` 文件也不直接等于迁移漏项；fork 的代次和冻结词表不同，需要为旧 deferral 明确记录替代证据。

## 执行证据与后续顺序

| 已执行 | 结果 |
| --- | --- |
| 完整 build；Client TypeScript | 通过；构建记录 244 个客户端产物 |
| scanner、user-text、upgrade-records、release readiness 的选定测试 | 4 文件、111 测试通过 |
| 主权检查；升级记录检查 | 通过，分别核对包分类和 21 份记录结构 |
| 完整 doc-sync | 31 通过、10 失败 |
| Python runtime closure；发布族版本检查 | 均失败 |
| SSH Linux 脚本入口；SSH macOS dry-run | 分别退出 127、1 |
| Schedule 无密钥浏览器复演 | suite 初始化失败，4 通过、4 跳过 |
| JSONL / watcher 临时复现 | 两个安全预期均失败，已记录实际观察 |
| SDK resource alias 复制实验 | 实验执行成功，确认绝对化与重定位失败 |

**修复后终验证据**（同一工作树，七项裁决与全部修复落地后复跑）：

| 已执行 | 结果 |
| --- | --- |
| 全量构建（host lib、client lib、web 应用、native darwin-arm64） | 通过；客户端产物记录 244 件 |
| `test:snapshot` 回放 | 336/336 通过——job-id 迁移金样经 keyless refresh 重录，规范化器头部先 claim + 悬挂引用记 `{{id:N}}` 后刷新稳定 |
| `test:expected` | 91/91 通过 |
| `test:web:full`（真实浏览器 e2e 115 spec） | 394 通过、12 跳过、0 失败——39 个失败全部定性处置：1 个真产品回归（admin-ui `SegmentedTabs` 桶缺失已修）、2 个测试基建回归（aria-normalize 作用域继承、git add 竞态）、其余为本轮有意契约变更的选择器/金样更新（新会话语义、scope 页式选择器、turn-process 表面、pi-ai 空目录、checkpoint 恢复流） |
| `test:coverage` 13 个失败逐项隔离 | 11 项并发负载抖动（隔离复验全绿）、1 项 CSS token 声明缺失（已修）、2 项 chat-view fixture 缺 `turn` 字段（按上游 fixture 签名修复，产品无回归） |
| hygiene / doc-sync / lint / typecheck / duplication / verify-package-dependencies / verify-upgrade-records / verify-no-unknown-casts | 分别 21/21、41/41、净、净、0.10% 阈值内、64 包、22 条、基线净 |
| pnpm-lock 289+/322- 审计 | 全部可归因：sharp ^0.35.5、React 19 对齐、ui-trajectory 工作区链接；无顺带升级 |

完整日志原保留在 `/tmp/coharness-rc2-audit-afc4bf40751/`，附件记录其哈希；三份临时探针源码也嵌入附件。临时测试已移除，现有源码、已提交 Session 代次和期望输出没有被改写。**修订**：宿主重启后 `/tmp` 已清空，上述日志与上游参照提取件不再可读；附件中的哈希仍可对原始获取物做完整性核对，但无法重建原文。此后修复证据改存持久路径（当前为仓库相邻的 `.rc2-work/logs/`，上游参照改为本地 `git worktree` 检出 `687f282e8625c6b8d11ff58211a90524be2e4317`）；本报告及台账以仓库内记录为准。

后续应先处理 JSONL 卸载、watcher 关闭和 SEA 并发写入；随后修复 SSH/Python 闭包、资源复制、图标和发布版本；再补上历史 UI 功能及相应真实组装回放。默认工具与凭据政策先统一现行决定。最后修复生成物和文档记录，补齐当前提交的发布证据及各平台验收。每个修复需对应准确的测试消费者和记录，不能用一个包的绿色单测关闭整个发布说明条目。

本轮没有执行 Windows/Linux 原生矩阵、真实 provider 调用、双用户部署或生产备份恢复，也没有对全部 838 次发布说明条目逐一做行为验收。Windows node-pty 退出排空补丁仍需专项平台复核；通用性能声明需要测量。对浅历史边界之前的问题，不将最早可见提交伪称为真正引入提交。
