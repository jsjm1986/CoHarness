# 上游对齐审计 — dsh-v0.1.6-alpha.2

## 目标调整依据

- 本轮目标由 `dsh-v0.1.6-alpha.1`（`0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`）调整为 `dsh-v0.1.6-alpha.2`（`ddefc45fbc7f8e46dd73185e68295696d1297887`），发布页 https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2（2026-09-17 发布，prerelease）。
- 证据来源：GitHub compare API（`0a15e36e...ddefc45f`：`total_commits` 887、300 个返回文件页）与 recursive git/trees 全树 blob 比较。2026-09-18 以本地拉取的上游 tag 复核：`git diff --name-status --no-renames dsh-v0.1.6-alpha.1 dsh-v0.1.6-alpha.2` 为 2,641 个变化文件（901 新增、57 删除、1,683 修改），累计 rc.2→alpha.2 为 5,507；新增包 9、删除包 1（`fs/tool-present` 实为迁移到 `deliverables/tool-present`）；`packages/session/session-format/src` 无变化。首版库存多计 2 个路径，原因是本地 `git ls-tree` 默认对非 ASCII 路径加引号转义而 GitHub trees 返回原始 UTF-8，`snapshots/web/present/workspace.expected/说明.txt`（三个 tag 内容相同）被同时计为删除和新增并生成一行伪行；矩阵已删除伪行并以 `core.quotePath=false` 对账。alpha.1 是 alpha.2 的直接祖先（merge-base 即 alpha.1），增量可与累计线性叠加。这些是范围证据，不是逐文件语义审查。
- alpha.1 的实施与验收历史保留在 [alpha.1 计划](../plans/UPGRADE-PLAN-dsh-v0.1.6-alpha.1.md)、[alpha.1 审计](UPSTREAM-AUDIT-dsh-v0.1.6-alpha.1.md)及对应清单/矩阵中，不并入本文件。

## alpha.1 → alpha.2 影响核验

- 发布说明与源码证据一致的接口级变化：新增 `dsh-hmr` 统一模块与配置重载队列；插件依赖运行时解析（CLI/桌面默认 `resolutionMode: 'runtime'`）；新增 profile 插件管理服务与 Web 插件页；`dsh <profile>` 启动。
- 生命周期变化：`agent-loop/src/inbox.ts` 将 Inbox 投影注册从实例构造移至 AgentLoop 侧，配套 `v8 ignore` 注释移除；本地当前实现仍在构造函数注册，需在 2B 阶段按 alpha.2 复核后再决定移植方式。
- subagent 继续对话默认最多 8 个存活子代理、委派深度 1，可在设置调整；涉及 `subagent/src/continuation*.ts` 与工具 README。
- `llm-deepseek` 源码变化集中在 messages 端点拼接、序列化、模型目录、files-api/file-store；`terminal-controller` 增加 `retain` 与系统用户执行语义；`subprocess` 含 Windows 无闪窗修复。
- 客户端 Session 多实例与 slot 变化集中在 `packages/client`（比较树未列出其下 src 逐文件清单于本审计，0R 展开矩阵时补全）；本地 Workbench 已有显式 Session/runtime 对应语义，需先做对应表再迁移。
- `packages/fs/tool-present` 被移除并由 `packages/deliverables/tool-present` 替代；`packages/boot/hmr`、`packages/boot/plugin-manager`、`packages/document/office-to-pdf`、`packages/skill/skill-office`、`packages/util/lazy-require`、`packages/client/ui-plugin-manager`、`packages/client/ui-sidebar-browser`、`packages/deliverables/workspace-changes` 为新增。本地既无 `fs/tool-present` 也无 `deliverables/`，rc.2 同步基线把该能力记为 upstreamOnly 推迟；2026-09-18 用户确认采纳（计划 D7）。
- 与本地 alpha.1 Phase 1 直接相关的增量：上游把 `packages/boot/app-boot/src/watch-config.ts` 及其测试整体迁到新包 `packages/boot/hmr`（rename 相似度 86%，与本地实现相差 11 行），`app-boot` 删除该文件并新增 `profile-context.ts`／`profile-plugins.ts`／`profile-sanitize.ts`；上游 `app-boot` 无 `assertEntriesLoaded`／`assertEntriesActivated`，`inactiveEntries` 改为返回结构化 `InactiveEntry[]` 并配合启动错误分类与诊断日志文件。vendor 增量仅 3 个文件：`vendor/loader/src/config/entry.ts` 的 `this.fiber` 改取 `registry.plugin(...).ctx.fiber`、`vendor/cordis/src/logger.ts` exporter 释放改按注册 id、`vendor/README.md` 新增第 20、21 条并把第 9 条路径改到 `boot/hmr`。
- Session 事件：`packages/core/session/src/known-event-types.ts` 新增 `workspace/changes`（由 `deliverables/workspace-changes/src/recorder.ts` 追加，`types.ts` 声明 `{ turn: number }`，未标 `ignorable`）；`SESSION_FORMAT_VERSION` 仍为 3。
- `.github` 增量为 14 个文件：`ci.yml` 仅新增 Playwright 安装前的 apt 镜像改写和 review-ownership 的 Python 单测步骤，`review-ownership/` 新增 blame 权重脚本；没有新增本地必须复制的测试 lane。`scripts/` 55 个文件待 0R 门禁差异比对。
- `apps/` 449 个增量文件中 `apps/desktop` 289、`apps/desktop-host` 11 属上游桌面客户端（本地 `apps/` 只有 android-shell、cli、web，从未携带），2026-09-18 用户确认不携带，矩阵拆为独立 reject 行；`apps/cli` 34 个文件（含 `profile-boot.ts` 的 runtime 解析默认与 `dsh <profile>`）归 1B，`apps/web` 115 个文件（112 个为测试）归 7A。
- 上游发布说明中未被原计划点名、已补入阶段表的条目：上下文用量移至输入框底部与会话拖拽区域修复（7A，与本地 composer 修复 #215–#217 重叠）、重复申请当前有效权限模式不再审批（6B）、会话被其他 DSH 实例占用时的提示（2B）、思考内容紧凑排版（7E）、Creator 移除 `tool-cordis` 动态定义与运行工具（7D；`tool-cordis/src/fiber-state.ts`、`inspect.ts` 已删除）。

## 用户决定（2026-09-18）

- `apps/desktop`／`apps/desktop-host`：不携带（矩阵 reject 行，理由与上游桌面 ui-package 树一致；apps/cli 共享接口经 1B 行审查）。
- D7：`deliverables/tool-present` 与 `deliverables/workspace-changes` 采纳，撤销 rc.2 基线的 upstreamOnly 推迟。
- Q1：插件安装允许上游全部四种来源（registry、绝对路径、git、tarball）；依赖构建脚本沿用上游批准模型（Web「允许并重试」／工具侧 `approvedBuilds`，按包名持久）。
- Q2：终端双门授权——管理员分别开启用户与项目，两者都开才可创建；终端归创建者私有；管理员仅列与关；只读成员完全不可用。
- Q3：侧栏 Browser 开放并与上游行为一致（iframe、loopback、每 tab 临时关沙箱）；loopback 地址提示指向访问者本机。
- Q4：Office 首发声明 macOS arm64（原生）与 Linux（WASM）；Windows 不宣称；Linux WASM 需一台验收环境否则标 unverified。
- 1B 启动审计：采用上游 `inactiveEntries` 结构化实现与诊断日志文件，替换本地 `assertEntriesLoaded`／`assertEntriesActivated`；本地 `disabled` 包装诊断与守卫测试在上游结构上重写。
- LibreOffice kit 事实：上游固定 `@deepseek-ai/libreoffice-kit@0.0.1`，原生包仅 macOS/Windows arm64 与 x64，Linux 选 WASM；缺声明的原生包是安装不完整，不会回退 WASM。

## 主权对账（2026-09-18）

- 2026-09-22 批次 0 归并后的当前矩阵为 329 个唯一 area，其中 295 个包级行登记 `localSovereignty`：adapted 221、replaced 2、tracked 6、upstreamOnly 38、unmanifested 28；另有 34 个 non-package 行。归并的 4 个已携带包统一为 `adapt`，源码审查仍 pending；其 ownership 取自当前 [同步记录](../../scripts/upstream-sync.json)，其余路由仍须逐阶段核实，不能由分类数字推导实现完成度。
- 不携带包的行为归属已逐行写清：35 个 upstreamOnly 行中 13 行标 `adapt`（增量须审查并把行为移植到替代面，如 `api/session-controller` 的 38 文件多实例增量归 7A 经 `host/apiproxy`、`ui-sidebar-documentpreview` 的 58 文件预览增量归 7C）、4 行 `defer`（agent-team×3、`client/file-upload`）、13 行 `reject`（含 `apps/desktop`、`apps/desktop-host` 与无消费者的实验/工具包）。
- `.github`、`scripts`、`lefthook.yml` 三行门禁面归 0R，在实施批次开工前完成差异比对与新增必需检查登记。
- 开发阶段姿态：允许破坏性更新，目标为上游全量对齐；全局管理设置经 `/admin`（`gateway/admin-ui`）落地；无生产数据，Phase 8 以合成数据迁移演练替代脱敏副本恢复。

## 源码级事实（2026-09-18 读码确认）

- `api/session-controller` 的"多实例"是引用计数 retain 模型：`sessions.retain(target, {source, signal})` 返回 `SessionReference`（`binding`／`ready`／`release()`），`SessionRetainInfo` 按来源计数，末次释放才拆本地 scope 与历史；`service.ts` 重写 557 行、`manager.ts` 减 250 行、`queue-mirror.ts` 删除。7A 移植的是 retain 模型，`client/runtime` 与 `host/apiproxy` 需要等价的引用计数与 teardown 语义，不是简单支持多个 Session。
- `webhook-github` 自带签名校验：`x-hub-signature-256` 经 octokit `Webhooks.verify`，无效签名 401、缺密钥 503，强制 `x-github-delivery`／`x-github-event` 头；`webhook` runtime 是 `ctx.webhookRuntime.register(rule)` 信任规则注册表，`run()` 在 Web Workspace 建 root Session。本地补强剩管理员开关、重放防护、限流与 Session 归属策略（7B）。
- `agent-loop` 本地已有 `turnBoundaryProjectionDefinition` 注册（index.ts:431）；alpha.2 仅在同处新增 `inboxProjectionDefinition` 注册（上游 416–417），与本地 `setupAndPublish`／`runMaintenance` 结构无冲突，2B 增量面小。
- `llm-deepseek` 的 Messages 修复是新增 `common/messages-api.ts`：`messagesApiRoot()` 统一规范化 endpoint root，files API 与请求路径改用之（替代内联 `/v1` 拼接）。
- `deliverables/workspace-changes` 的 `TurnRecorder` 在每个 turn 起止对 git 工作树做快照、对非 git 覆盖路径在文件工具编辑前后做整文件捕获，`workspace/changes` 事件只携带 turn 摘要；非 git 目录只列文件工具编辑。
- `apps/cli/src/profile-boot.ts` 是重写：补丁分层栈（bundlePatches/homePatches/overlays、`allPatches`）由 `readProfilePatches`/`ProfileContext`（新文件 `app-boot/src/profile-context.ts`）取代；`resolveTelemetryPatch` 是**移动**非删除；新增 `healIsolatedProfileModuleFallback` 与 `resolutionMode` runtime/link/dual 三态（`dual` 走 `behavior:'verify'`）；上游 `inactiveEntries` 同样以 phase 标注包装 disabled 表达式错误，与本地 `assertEntries*` 守卫同型，1B 采用上游实现时本地守卫语义可直接映射。新增 `resolved-profile-boot.spec.ts`／`startup-diagnostics.spec.ts` 两份行为测试。
- retain 模型的真实消费点：`terminal-controller/src/client/retention.ts` 以 `remote.retain(sessionId, id, signal)` 持有终端窗口——retain 同时是 Typert Remote 动词，7A 移植的 retain Remote 是 7B 侧栏终端窗口持有的前置依赖（与阶段排序一致）。本地 `client/runtime` 的 `ISessions` 是 `open`/`setAdditionalStaged` 选择模型，非引用计数，移植需新增 per-consumer 引用而非改名。

## 0R 门禁收编登记（2026-09-18 执行）

上游 `scripts/` 新增约 70 个门禁／生成脚本，`run-gates.ts` 引用者按当前本地可执行性分三类收编；`lefthook.yml` 的上游 glob 拓宽对应其 `browser-bundled-externals` 与 desktop lock 输入，本地 gen 不消费这些输入，现有 glob 已覆盖本地 gen 全部输入，无需改。

**0R 收编并接入 `docSyncLeafGates`（当前全绿）**：

- `verify-dependency-catalog`（＋`gen-dependency-catalog`）：生成 `docs/dependency-catalog.json` 并入库。
- `verify-repository-references`：本地适配三处——`upgrades/` 与 `.agents/notes/` 为记录本体豁免 commit-hash 检查、SHA 允许指向本地 HEAD 祖先（上游 tag 提交非祖先仍合法）、`kitRepositoryUrl` 白名单；配套修复陈旧 `github.com/deepseek-harness/deepseek-harness` 链接、`docs/user/develop/basic/publish*.md` 删 turtle-ui 链接（与上游同改）、`gen-third-party-notices.ts` vendored 行改本地 `vendor/` 路径并把 `node-addon-system` 族列入 first-party，`THIRD_PARTY_NOTICES.md` 已重生成。
- `verify-cordis-inspect-catalog`（＋`gen-cordis-inspect-catalog`）：`sessions.ts:146` `ensureSession` 缺 JSDoc 已修。

**随阶段收编（脚本在树并 `package.json` 登记、未接车道，阶段放行前必须接绿）**：

- 2B：`verify-session-format-catalog`（＋`gen-session-format-catalog`）。上游 `persistence-*` 提取器族（`persistence-schema`、`persistence-formats`、`persistence-releases`、`persistence-changes`、`render-persistence-schema` 及配套 facts/source 模块与规格）依赖 `types.ts` 的 `SurfaceIntent<K>` 别名重构（alpha.2 事件面变更），本地旧内联交叉形式渲染出 `& object` 被拒；0R 保留本地旧版 `gen-persistence-catalog.ts`（其 `--check` 当前绿），该族文件与 `verify-persistence-*` 条目已撤下，随 `SurfaceIntent` 迁移在 2B 一并重拷接入。
- 4A：`verify-workflow-guest`（＋`gen-workflow-guest`）。
- 7E：`verify-client-ui-i18n`（332 处违规是全客户端本地化改造，ui-trajectory 130+、ui-primitives 40+；`ui-message-feedback` 的诊断码字面量已按修法修正）、`verify-package-readme-summaries`（295 处缺 `## Summary`）、`verify-tsconfig-paths`（＋gen）、`verify-subsystem-pages`（5 个新包缺归属链接）、`verify-application-entrypoints`（4 处入口分类）、`verify-concrete-terms`（43 处来源字段名与上游术语重命名同源，随 2B/7E 对齐清除）。

**拷贝后评估为耦合过早、已撤下待阶段重拷**：`verify-default-product-isolation`（依赖上游 `verify-client-packages.ts` 新增导出，7E 随该文件上游变化一并带入）、`benchmark-next-package-dependency`（同上）、`browser-bundled-externals`（依赖上游 `apps/web/product-isolation.ts`，7E）、`session-snapshot-corpus*`（依赖未携带的 `dsh-session-snapshot` 包，随该包进入阶段）、`snapshot-spill-locators`（依赖上游 `SpillSource.kind`，随 spill 包升级阶段）、`test:expected`／`test:docs`（依赖上游 `doc-quick` 车道与 expected 语料，7E 评估与本地 `test:snapshot` 对应关系后定）。

**不适用（上游专属，不拷贝）**：`issue-management`、`preview-sizing`、`review-ownership` blame 权重、`e2b-e2e.yml`（上游已删）、desktop/inspector 门禁、`apps/desktop` 相关 CI 步骤。

doc-sync 车道现状：31/31 通过，含三个新接门禁（npm dependency catalog、repository references、cordis inspect catalog）。

## 本审计的边界

- 尚未完成全部累计与增量文件的逐文件语义审查，未完成所有消费者验收。当前 schema v3 矩阵为 329 行：320 行 `pending-cumulative-source-review`，9 行保留 `implemented-local-tests-passing`；后者仅保留已记录范围的本地验证，不覆盖新候选或未运行环境。批次 0 已使累计 5,507 路径、增量 2,641 路径与固定 Git 原始差异逐一一致，这只证明范围完整，不证明语义等价。
- 本地规划检查点 `6f0ec56328` 与上游 tag 无祖先关系；树差异不证明等价。
- alpha.1 遗留的未验证项、环境阻塞、不稳定用例与观察项集中在下表，初始为 23 项，后续追加 L24、L25，当前共 25 项。alpha.1 记录中没有独立枚举清单，本表由旧审计及后续验证逐条整理。换目标不清空欠账；销账须记录验证提交、命令与环境。

## 未验证与环境阻塞台账

| 编号 | 项 | 类型 | 来源 | 承接阶段 |
| --- | --- | --- | --- | --- |
| L1 | 早期 Phase 1/2 覆盖率缺口及本轮候选重验 | 历史已验证；新候选待验 | alpha.1 审计"Phase 1：Node 内部加载器依赖"、两处收口 | 保留 8-e.1 本地记录：4 分区 1201 插桩文件 + exempt-heavy 21138 测试，合并阈值零违规；另核实 `2ba86fcbb908dd90226dbf5a62148099d24d6607` 的 [CI 全量覆盖率步骤](https://github.com/jsjm1986/CoHarness/actions/runs/35688456271/job/106620429647)成功。本轮候选不得复用该提交的结果 |
| L2 | 真实 provider e2e：DeepSeek 双协议、BYOK 与组织代理路由、凭据归因 | 未验证 | alpha.1 审计各批 | 3A |
| L3 | 组装快照未覆盖 Messages、图片、PTC 新面 | 未验证 | alpha.1 审计"Phase 2 收口" | 3A、3B、4A |
| L4 | Python SDK 打包产物仅 macOS arm64 carrier 冒烟通过，Linux/Windows 产物未验 | 部分验证 | alpha.1 审计"Phase 2 收口" | 8 |
| L5 | 跨平台原生验证（Linux/macOS/Windows；vendor 同步、subprocess、sandbox、landlock） | 部分验证 | alpha.1 审计"Phase 1：Node 内部加载器依赖" | macOS 26.6.2 arm64 已实测：subprocess-local＋sandbox-local＋sandbox-policy 415 通过／15 跳过，seatbelt e2e 5 通过（真实 sandbox-exec）；landlock/bwrap 为 Linux 专属按设计跳过；Linux/Windows 待 CI 平台矩阵（L18） |
| L6 | 独立 Gateway 与树外治理插件业务回归 | 未验证 | alpha.1 审计"旧启动事件移除与全量验收" | 2B、7A、7D |
| L7 | 桌面能力验收（computer-use、browser-use；GUI 主机权限） | 未验证／缺环境 | alpha.1 审计多批 | 5、6A（Q4） |
| L8 | LAN/公网真实双用户验收 | 未验证／缺环境 | alpha.1 审计多批 | 6B、7B、8 |
| L9 | 生产迁移演练、一致备份恢复、发布闭包与健康证据 | 部分验证 | alpha.1 审计各收口 | 8-d 合成数据迁移演练已实测（macOS 26.6.2 arm64）：session-format v0→v1→v2→v3→v4 代次链含 combined/preset 迁移、不可变代次与 multi-edge publication、未来格式拒绝（migration-refusal）、verifier worker 生命周期（migration-verifier）、SQLite v18↔v20 离线迁移与回滚——50 文件 1628 测试全绿；8-e 发布闭包：coverage 分片、hygiene、build、built smoke（12 文件 43 测试）、release:verify/pack（281+9+1 tarball）、packed-install（291 tarball 装入消费者，`dsh --version` 实测）全绿；8-e.3 复测另修复源码启动平面混合缺陷（profile-resolution ambient source 探测 + `TOOL_RUNTIME_SCHEDULER` 恢复 `Symbol.for`，见 `2026-09-21-profile-resolution-ambient-source-plane`）；生产备份恢复与双用户验收仍待 8-f |
| L10 | 原生 watcher `EMFILE`（errno -24，软／硬限额 unlimited 仍复现） | 已验证 | alpha.1 审计"非事务 Loader 适配（过程批次）" | 1B 迁移后复测：迁移后 `boot/hmr` chokidar watcher 在 macOS 26.6.2 arm64（`ulimit -n` 软 1048575／硬 unlimited）下 `packages/boot/hmr/tests/` 68 测试全绿，EMFILE 未复现；部署前提已写入 `gateway/deploy/README.md` |
| L11 | 宿主 Python 3.9.6 低于 3.10，`ptc-runtime-python` 两个测试文件失败，测试以 3.12 绕过 | 已验证 | alpha.1 审计"干净基线测试" | 8 部署前提：`python3`→CPython 3.12.13 下 `packages/experimental/ptc-runtime-python` 284 测试通过／2 跳过；3.9.6 在加载时被版本门禁拒绝（245 断言失败即拒绝证据）；前提已写入 `gateway/deploy/README.md` |
| L12 | `session-persistence-jsonl/tests/lease.spec.ts` 全量并发下失败、隔离通过 | 不稳定 | alpha.1 审计"实施后全量复跑" | 2B |
| L13 | ACP 子任务／标题等待超时偶发，修复保持原期限 | 不稳定 | alpha.1 审计"旧启动事件移除与全量验收" | 2B、7A |
| L14 | Python runtime 清理耗时 4074ms 超过 4000ms 偶发；输出上限预期得到 timeout | 不稳定 | alpha.1 审计"串行创建与启动 hooks"、"Node 内部加载器依赖" | 4B |
| L15 | 快照请求数 2 而非 1 偶发，原因未定 | 不稳定 | alpha.1 审计"串行创建与启动 hooks" | 2B |
| L16 | Claude/Codex hooks、Landlock 后台分类 5 秒超时偶发 | 不稳定 | alpha.1 审计"非事务 Loader 适配收口" | 2B、4B |
| L17 | `watch-config.spec.ts` 首次配置添加未生效偶发，隔离通过 | 不稳定 | alpha.1 审计"Node 内部加载器依赖" | 1B 迁移后复测 |
| L18 | 当前候选的 CI 必需任务及尚未运行的原生平台验收 | 历史 CI 已验证；新候选与缺失平台待验 | 计划证据要求 | `2ba86fcbb908dd90226dbf5a62148099d24d6607` 的 [CI 35688456271](https://github.com/jsjm1986/CoHarness/actions/runs/35688456271)为 success：15 个 job 成功、11 个 skipped；覆盖率、Wine、Web、SDK/Gateway 等已执行任务的证据只属于该提交。该次原生 Windows complete、macOS serial、manual full audit 等未运行，不能据汇总绿灯销账；新候选重新验收 |
| L19 | `Fiber.update()` 返回 void 后，运行期配置更新失败只留在 fiber `_error` 与日志，无等价于启动路径的审计 | 观察项 | alpha.1 Phase 1 代码审查 | 1B |
| L20 | 串行 `agent/created` 监听器顺序为隐式注册顺序，无显式编排 | 观察项 | alpha.1 Phase 2 代码审查 | 2B |
| L21 | `tool-cordis` api-catalog 的 `agent/created` 参数描述缺 `agent`／`source`，goal `resume` 描述有语法错误 | 已验证 | alpha.1 Phase 2 代码审查 | 7D 销账：`@param payload.*` 点名在 `parseTags` 正则处坍缩为 `payload`，末位标签覆盖前者——改为单 `@param payload` 续行枚举三字段；`resume` 措辞对齐上游 `session-start edge`；`gen-cordis-api` 重生 + `verify-cordis-api` 105 产物同步；上游同缺陷，修复可上游化 |
| L22 | 上游 profile-resolution／required-startup 策略在 alpha.1 推迟至发布闭包 | 推迟项 | alpha.1 审计"非事务 Loader 适配收口" | 1B（alpha.2 runtime 解析直接覆盖） |
| L23 | Session 迁移链拆为上游 `session-format-*` 独立包的可选结构对齐 | 推迟项 | alpha.1 计划 | 7E 可选 |
| L24 | 覆盖率全量并发下 5s/30s 短超时抖动：`persistence-schema`（10）、`verify-package-dependencies`（3）、`gen-client-catalog`（1）、`oxlint-contract`（1）、`tools-catalog`（1），隔离全过 | 已验证 | 8-e coverage 门禁复跑 | 8-e.4 销账：`tools-catalog`/`project-doc-site` 抬显式 120s 预算；`gen-client-catalog` 对 oxlint 探针 ENOENT 竞态加容忍；被杀门禁遗留探针孤儿已清理；8-e.1 收口复跑（4 分区/6 worker/300 全程）无抖动复现 |
| L25 | `acp-snapshot` `waitForTurnEnd` 20ms 断言在高负载下迟判为 `Timed out in waitFor!` | 已验证 | 8-e coverage 门禁复跑 | 8-e.4 销账：该 spec 全部 20ms 等待断言统一抬 250ms（首回调在高负载下排不进 20ms 窗），8-e.1 收口复跑无复现 |

## 1B 执行台账（2026-09-18 首批落地）

**已采用（整包/整文件对齐上游 alpha.2）**

- `packages/boot/app-boot` 整换：`readProfilePatches`/`ProfileContext`/`healProfilesModuleFallback`/`healIsolatedProfileModuleFallback`/`resolutionMode` runtime/link/dual/`auditStartupEntries`/`StartupError`/`inactiveEntries` 结构化诊断；本地 `assertEntries*`/`watchUserPatches`/`resolveTelemetryPatch` 旧面退役（telemetry patch 移入 `profile-context.ts`）。
- `packages/boot/hmr` 新建（`@deepseek-ai/dsh-hmr`）：base bundle `cordis.patch.yml` 以 `dsh-hmr` 替换 vendored `cordis-plugin-hmr`，`root: []` + `disabled: !!js "!ctx.get('profileContext')"`；web-app 移除本地 `disabled:true`+TODO（上游已证明 web 安全）并加宿主面 `tool-plugin-manager` disable 行。
- `packages/boot/plugin-manager` 新建：base patch 加 `tool-plugin-manager`/`plugin-manager` 行；`pnpm` devDep + `manager.spec` 夹具改用工作区 pnpm（本地无 `apps/desktop` 路径）。
- `packages/boot/cmdline`、`packages/host/plugin-inventory` 整换；`cmdline` 的 `runDumpConfig` 新增 `fromDefaultProfile` 参并在 `dump-config.ts` 重放 preset 接线。
- `apps/cli`：上游 src（`args/bin/plugin/profile-boot/startup-diagnostics`/`dump-config`）+ 单测 + `tests/profiles/` 夹具骨架；`package.json` 依赖为本地基与上游可解析集并集（webhook/agent-team/tool-present/ptc 等未携带包正确排除）；`tsconfig` 补 `boot/plugin-manager` 与本地 `apiproxy/http-proxy` 引用；`js-yaml` 升 `^5.2.3` 与 vendored include 对齐（v5 `deficient indentation` 诊断断言已随测）。
- `packages/util/lazy-require` 新建（上游 1B 行；消费者 terminal-controller/subprocess 属后续阶段，先行落地无消费方）。
- `packages/preset/persona` src+spec 整换：`getSectionOrder` 服务方法替代 `FIRST_PARTY_SECTION_ORDER` 常量、`text` 别名删除；`tool-subagent` 仅点修同一 API（其整包迁移挂 2B 的 `SubagentRuntime.resolveMaxDepth`）。
- `SystemPrompt` Config `persona`→`personaPrefix` 全部消费点（examples/demo 的转发键同步；`SubagentCapabilities.persona` 布尔字段保留不动）。
- 新 bundle：`packages/bundle/{acp-app,sdk-app,sdk-minimal}` 与 `packages/mcp/mcp-resources`（依赖闭包本地齐全）；`tsconfig.base.json` 补 `dsh-plugin-manager/tools` 子路径映射；`tsconfig.host.json` 注册全部新包。
- vendor 两处重放 + `vendor/README.md` 条目；`snapshots/acp/escalation-approved/` 夹具目录补拷（cordis.yml 符号链接目标）。
- 全部新包按本地政策补 explained-empty `src/invariant.ts` + `./invariant` 导出 + `lib/invariant.js` + invariants 依赖 + tsconfig 引用（上游弃伴随的包同样恢复）。

**本地特性保留**

- `SHIPPED_PRESET_ROOT`/`resolveShippedPresetPatch`/`composeProfilePatches` 重放进新 `profile-boot.ts`（`readProfilePatches` 结果后追加 derived patch，与 telemetryPatch 同型）；上游 alpha.2 已把等价机制收进 `agent-presets` 包的 `includeShippedRoot`，7E 整包迁移时本地 launcher patch 随之退役。
- `apps/web/tests/scaffold.ts` 保留本地 gateway/downlink 脚手架（整换会丢 CoHarness 组装），仅点修 `healProfilesModuleFallback` options-object 签名与 `auditStartupEntries`。

**撤下待阶段重拷（e2e 依赖未落地 API，不造假）——2026-09-21 终裁**

- → 2B（`generationLogFilename`/`JsonlCompression` 已落地）：`session-format-guard.expected.e2e.ts` **已重拷**，keyless 4/4 过
- → 3A/2B（`dsh-session-snapshot`）：acp 7 件、headless 5 件 **不移植**——本地快照车道为 `*.snapshot.ts` 脚本/示例架构（`session-format-guard.snapshot.ts` 等已覆盖同场景回放），上游 harness 包无本地消费者
- → 4A（`ptc-runtime-node` 已落地）：`ptc.e2e.ts` **已重拷**，5 过 + 2 凭据门控 skip；`Tool` provider 名册断言适配本地 cordis 全量自修改工具面（7 项 vs 上游 inspect-only 2 项）
- → 7A（`WebBootGraph.batches` 未移植——combo 调度层是上游 bundle 架构，移植属产品决定）：`runtime-roster.ts`/`runtime-roster-observer.ts`/`default-web-process.ts`/`web-default-isolation.expected.e2e.ts` **继续挂 7A**
- → 7B/7D（mcp@2.0 已落地）：`creator-plugin-manager.expected.e2e.ts` + fixture **已重拷**，1/1 过（真实 `apps/cli/lib/bin.js --profile web`，MCP 安装→重启恢复→移除全生命周期）。**重拷暴露真实产品缺口**：上游 preset 携带 `tool-plugin-manager` 行（cordis 启用、standard/ptc 禁用占位）而本地 preset 缺失，web 宿主面又已按上游禁用宿主行——本地 web agent 实际无 `plugin_manager`。已按上游构图补齐三个 preset 行
- → 7E（`SHIPPED_PRESET_ROOT`/`modeSelectionEnabled` 未移植）：`web-agent-presets.e2e.ts` **不移植**——移植试跑 24/32 失败，preset 名册/`str_replace_editor`/session create-vs-load 语义/`userdoc-http` 宿主服务深度分歧；`mount.spec`/`session.spec`/`settings.spec` 包级套件覆盖同语义空间，`agent-preset-*.e2e`/`shipped-composition.e2e` 覆盖 web 面
- `packages/test-support/session-snapshot` 包整体不落地（本地 `*.snapshot.ts` 车道承接回放；级联缺 `prepareSessionSnapshotFixtureForComparison`/`parseSessionFormatLogFilename`）

**门禁 spec 补齐（2026-09-21 重拷）**

- `session-query-spill-command.spec.ts` + `resolve-spill-command.{mjs,d.mts}` 夹具：1/1 过
- `snapshot-http-fixtures.spec.ts` + `loopback-fixture-server.mjs`/`web-search-error-fixture.mjs` 夹具：4/4 过
- `web-product-bundle-isolation.spec.ts`：**24/24 过**，并补齐缺失的 Vite 产物面接线——`apps/web/product-isolation.ts`（`productWebBundleIsolation`/`browserDependencyAnalysis` 适配器）+ `vite.config.ts` 插件挂载；真实 `vite build` 无违规通过。此前本地仅有 tsdown `BundleInputIsolation`（输入面），产物面是缺的第四条腿
- **不移植**：`doc-standard.spec.ts`（上游 README 骨架/frontmatter 惯例，本地 i18n sidecar 体系由 docSyncLeafGates 覆盖）、`ci-compatible-selfhosted.spec.ts` 与 `tests/ci-{master-platforms,release-selfhosted}.spec.ts`（断言上游仓库身份 `deepseek-harness/deepseek-harness` 与 `vm-backup` runner，本地 `ci-workflow.spec.ts` 承接）、`build-exe-for-python-sdk{,-assets,-office}.spec.ts`（本地 dispatcher 重写版入口/资产面分歧，`native-pty` spec 覆盖共享面；office 能力未采纳）、`libreoffice-engine.spec.ts`（office/document 未采纳）、`preview-workflow.spec.ts`（Cloudflare 预览 workflow 不存在）、`browser-bundled-externals.spec.ts`（上游 bundle 粒度声明机制，本地 notices 走声明分层覆盖）

**阶段改挂**

- `packages/typert/{generator,loader,protocol,registry}`：矩阵 1B→7A。协议迁移（`TypertLookupFailure`→`TypertLookupWire`、`codec.schema`→`create`、`$dispatch` 移除、`TypertGatewayAuthorizationRequest` 删除）波及 `api/gateway`、`api/remotes`、`host/apiproxy`、`extensions/cordis-host-runner` 与 15+ 个 `ui-*` 测试——属 gateway 面而非 boot 面；1B 试换后回退，不引入新旧并存。

**1B 末态验证**

- `pnpm exec tsc -b --pretty false`：0 错误
- `verify-package-invariants`：263 伴随全合规
- `verify-cordis-config`：150 配置全过
- 聚焦测试 597/601：`app-boot` 82、`hmr` 全量、`cmdline`、`plugin-manager`（manager/operations）、`windows-shell` 6、`profile-hmr` 6、`shipped-preset-root` 3、`resolved-profile-boot` 16、`startup-diagnostics` 6、`persona` 12、`tool-subagent` 全量、`lazy-require` 2
- 残留 4 失败：`plugin-manager/tests/tools.spec.ts` 权限断言读上游新 sandbox-projection 语义，合法阻塞于 2B/4B（`dsh-sandbox-policy` 未迁），不 hack。

**1B 补登（2026-09-18 第二批：门禁与遗留修复）**

- `apps/cli/tests/fixtures/initialize-profile-from-default.ts` 补拷（race 测试子进程夹具，拷贝 spec 时漏带）；`github-webhook/` 夹具属 7B 不拷。`profile-initialization.spec` 16/16。
- `packages/examples/agent-spine-demo`：上游 `SystemPrompt.Config` 移除 `persona` 后，demo 自有 `persona` 字段需在自有 z.object 分支显式声明（`persona: z.string()`），且 `personaPrefix` 经 schema 默认 `''` 恒非 undefined——转发优先级改为 `personaPrefix || persona || ''`；`bundle/base/cordis.patch.yml` 漏改的 `persona:` 键同步改为 `personaPrefix:`。agent-core 30/30。
- `ui-message-feedback` controller：非 Error list 拒绝的稳定消息回退补回 `message feedback list failed`（与 mutation 路径同款）。38/38。
- `packages/bundle/sdk-minimal`：`@deepseek-ai/dsh-invariants` dependencies/peerDependencies 重复声明移除，`verify-package-dependencies` 过。
- **撤下三个上游门禁文件**（依赖未携带面，随所属阶段重拷）：`doc-standard.spec.ts`（session-format 发布记录文档树，2B/7E）、`ci-compatible-selfhosted.spec.ts`（断言上游 ci.yml 形状，CI 阶段）、`verify-application-entrypoints.{ts,spec.ts}`+package.json 条目（断言上游 examples→CLI-profile 迁移已完成的清单）。
- `packages/examples/` 保留为 fork 自有面：上游已整删（迁 CLI profiles），本地 15+ 文档引用与 demo:* 根脚本使其删除爆炸半径超出 1B；登记为独立任务（examples 删除/重分类随 7E 文档面一并处理）。
- scripts 套件复跑：87 文件 977 测试全绿。

**1B 补登（2026-09-18 第三批：目录生成物与子系统页集成）**

- `gen-cordis-catalog.ts` 补新包分区映射：`hmr`/`pluginManager`/`profileContext`→`boot.md`，`mcpResources`→`mcp.md`，事件域 `hmr`/`plugin-manager`→`boot.md`；`pluginPackages`/`appReady` 不可见 Context merge 键入 `SERVICE_WALK_EXEMPTIONS`（归属文档随条目）；`PromptSectionOrderName`/`PromptContextOrderName`→`system-prompt.md` 类型映射恢复。生成 101 artifact、3 件写入（`tool-cordis/src/api-catalog.ts` 获 hmr/mcpResources/pluginManager/profileContext 服务条目，system-prompt 页获 `getSectionOrder`/`getContextOrder` 生成区）。
- 上游子系统页整拷：`docs/subsystems/{boot,mcp}.{md,zh.md,i18n.yaml}`，`README.md`/`README.zh.md` 索引行补齐；上游 `website/docs.ts` 未投影这两页，本地保持一致不注册。
- `gen-tool-catalog.ts` 补 `dsh-plugin-manager`（`ctx.provide('pluginManager')`+`SandboxPolicy` mount）与 `dsh-mcp-resources`（`mcpResources.register('catalog')`）两个 TOOL_PACKAGES recipe（上游原样移植）；en 目录重生含 `plugin_manager` 与 3 个 mcp 资源工具节；zh 目录移植上游对应章节与映射表行，`来源：` 格式归一到本地约定。
- 死链修复（`verify-md-links` 语义）：`mcp-client` 的 `#use-this-package` 锚对齐本地实际节 `#config`（zh README 补 `<a id="config">` shim，双语链接统一英文锚——配对门禁要求两侧锚一致）；`acp` 的 `#standard-acp-v1-surface`→本地 `#protocol-contract`（zh shim 已存在）；`base`/`agent-loop` 缺失节锚去 fragment 降为文件链；未携带目标（`computer-use` 页、`computer-use-cua-driver-native`、`mcp-memory` 指南、两份 9 月 Agent Note、`sparse-first-party` 归档 note）按惯例转纯文本，随所属阶段重拷时恢复链接。
- 配对重录 15 条 `.i18n.yaml`；`verify-md-links` 2532 文件全过、`verify-translation-pairing` 1264 对全一致、`verify-tool-catalog`/`verify-cordis-catalog` 生成物同步、`verify-doc-budgets` 9、`verify-subsystem-pages` 7/7、`doc-typecheck` 92 块编译过、oxlint 与 `git diff --check` 干净。

## Phase 8 执行台账（2026-09-19：部署前提与迁移演练）

**8-b.7 收口（客户端本地化波次）**

- `verify-client-ui-i18n`：492 个 client UI 源文件全部 locale-owned，零硬编码 copy。
- `ui-primitives` 全部 labels/copy props 改必填（`JsonTree`/`Modal`/`HoverCard`/`ConnectionBanner`/`CodeBlock`/`DiffBlock`/`ReadBlock`/`SearchBlock`/`TerminalBlock`/`WebBlock`/`MarkdownText`），消费方经 `t`+labels 工厂接线；`codeLabels` 并入 `MarkdownLabels.code`。
- `tool-call-model` 标题表改上游 `titleKey` 机制并纳入 `read_image` 分类；card-model 的 args 派生重构（上游删 `callView`/`resultView` 消费）属契约级架构分歧，登记为延迟端口不在本车道。
- `Label`→`LabelKey` 键槽重命名（`submitLabelKey`/`cancelLabelKey`/`submitBusyLabelKey`）；`brand.product` 入 common 字典，`DocumentTitle` 收 `productTitle` prop 经 `ctx.get('locale')` 快照绑定；新增 `ui-usage-alert` locale 命名空间。
- `pnpm run typecheck`、knip、492 文件 i18n 门禁、118 文件 1952 UI 测试全绿；`ui-renderer` 补 `../locale` project reference。
- 误发产物清理：`packages/client/**/src` 内约 400 个 `.js`/`.d.ts`/map 杂散产物删除并复跑确认零残留。

**8-c 部署前提证据（写入 `gateway/deploy/README.{md,zh.md}`）**

- EMFILE：迁移后 `boot/hmr` chokidar watcher 在 macOS 26.6.2 arm64（`ulimit -n` 软 1048575／硬 unlimited）下 68 测试全绿，未复现。
- CPython：`python3`→3.12.13 下 `ptc-runtime-python` 284 通过／2 跳过；宿主 3.9.6 由版本门禁在加载期拒绝（245 断言失败即拒绝证据）。
- 平台能力：subprocess-local＋sandbox-local＋sandbox-policy 415 通过／15 跳过；seatbelt e2e 5 通过（真实 sandbox-exec）；landlock/bwrap 为 Linux 专属按设计跳过，归 L18 CI 平台矩阵。

**8-d 合成数据迁移演练（销 L9 迁移演练部分）**

- `session-format-v0-to-v1` validation spec 断言补齐：`tool/code-dispatch`/`tool/code-dispatch-start` 随 `assistant/chunk` 在 v4 退役，released-v0 清单差集期望漏更新（与上游 alpha.2 同文件一致，属合并漏项修复）。
- 演练命令：`pnpm exec vitest run packages/session/session-format*/tests packages/session/session-persistence-jsonl/tests packages/session/session-persistence-sqlite/tests scripts/session-sqlite-migration.spec.ts`——50 文件 1628 测试全绿。
- 覆盖：v0→v1→v2→v3→v4 代次链与 combined/preset 迁移、不可变代次（generation/multi-edge-publication）、未来版本拒绝（migration-refusal）、verifier worker 生命周期（migration-verifier）、SQLite v18↔v20 离线迁移与回滚（合成库，`mkdtemp` 隔离、无 live WAL 拷贝、无双写）。
- 未覆盖仍挂 L9：生产一致备份恢复、发布闭包健康证据（8-e）、LAN/公网双用户验收（8-f）。

**8-e 发布闭包与健康证据（2026-09-20 执行）**

- coverage 分片（`test:coverage:partitioned`）：豁免表收窄——`packages/typert/` 整体豁免改为仅 `typert/generator`（loader/protocol/registry 迁入后其 spec 应入插桩运行）；豁免契约 spec 同步更新。11 个失败 spec 逐项修复：JSONL 持久化 fixtures 补 `sessionPersistence.create` 认领写句柄（agent-team `checkpoint-child`、persistence `persistedChild`）、`jsonl-restart`/`llm-retry` 对齐上游显式 create/open-read 流程、`cordis-host-runner` 断言对齐新错误文案、`canonical-envelopes` 恢复上游 opaque 期望（v4 admission 只拒非 ignorable dispatch 对）、`gen-tool-catalog` 补 stagehand 期望行、schedule plugin `PersistenceProbe` 补 `create`、ui-conversation 三个 spec 断言转 zh 字典值、ptc-runtime-python 走 3.12 PATH。
- built smoke（`built-bin-smoke` 门禁集，`DSH_EXAMPLE_MODE=lib`）：12 文件 43 测试全绿；`keyless-smoke` 在 src/tsx 模式亦绿。修复清单：① `agent-loop` 配置 agent 持久化挂载竞态——Loader group `Promise.all` 并发挂载，`agent-loop` 构造时 `sessionPersistence` provider fiber 未 ACTIVE，严格 `ctx.get` miss 导致配置 agent 永不落盘；修复为 miss 时经 `ctx.get('loader').await()` 等组合树 settle 后重查（产品级潜伏 bug，上游同码亦存此竞态，已立 Agent Note `2026-09-21-configured-agent-persistence-mount-race` 并在 `upstream-sync.json` 挂 `core/agent-loop`）；② cli 补回 `dsh-acp-app`/`dsh-sdk-app`/`dsh-sdk-minimal` 三个依赖（合并丢失导致 built bin 下 sdk/acp profile 无法解析）；③ remotes invalid-input 断言对齐本地 envelope 语义（`gateway/input-invalid`）；④ headless 断言对齐本地 `progress` 默认关、web URL 无 token（台账已记 adapted-removed）；⑤ `loader-smoke` 补拷上游三个 fixture（`cli-mock-llm`/`headless-driver`/`production-profile`）并补 `dsh-app-boot`/`dsh-http-proxy` devDep。
- 包布局与打包安装：`release:verify --family dsh`（281 成员 `0.1.5-alpha.1.coharness.1`，发布序解析，2 条 peer 无序按设计接受）、`verify-package-dependencies`（55 包合规）、`verify-npm-install-layout`（223 包/734 内部边/共享 Cordis/2316 peer 边）、`build:official`（212 client artifacts）、`release:pack`（281 dsh + 9 vendor + 1 landlock entry tarball，逐成员 payload 校验）。
- packed-install 验证（`verify-packed-install` 复刻，291 tarball 装入临时消费者）：`verifyInstalledProductIsolation` 565 个默认产品包不含 experimental；安装后 `dsh --version` 在 plain node 下报 `0.1.5-alpha.1.coharness.1`。两处宿主差量已记录：tarball 移至纯 ASCII 路径（npm 11.11 无法打开百分号编码的非 ASCII `file:` URL）；optional deps 改为包含（koffi 3.3.1 源码构建在 darwin 无法链接 napi/uv 符号——其 cnoke/CMake 无 `-undefined dynamic_lookup`；`--omit=optional` 源码构建腿由 CI 在 linux 承担，linux ld 允许未定义符号）。
- 8-e.3 复测暴露产品级潜伏缺陷（源码启动平面混合）：profile-resolution 把插件入口路由到 declarer 的 `node_modules` 清单（tsx paths 不覆盖该 importer）→ 入口落 `lib/`，而插件内部裸导入经 tsconfig paths 落 `src/` → `dsh-tools` 双实例 → `TOOL_RUNTIME_SCHEDULER` 符号分裂 → 首个工具调用 `UNKNOWN: prepare` 崩溃（`pnpm build` 后 `pnpm dsh` 必崩）。修复：`installProfileResolution` 在 enforce/verify 前探测 ambient 解析，命中 TypeScript 源码产物则优先 ambient（`resolver.ts`）；`TOOL_RUNTIME_SCHEDULER` 恢复 `Symbol.for`（9-18 决策在 alpha.2 合并中被回退为 `Symbol()`，此次一并恢复）。回归 spec `apps/cli/tests/profiles/headless/tests/source-launch.spec.ts` 走真实 `bin.ts`+tsx+`PluginPackages`+工具调用，对修复前实现失败。`resolver.ts` 四项 100%；agent-loop 379、app-boot 246、built-bin 31/31 绿。Agent Note `2026-09-21-profile-resolution-ambient-source-plane`；`upstream-sync.json` 挂 `boot/app-boot` 与 `core/tools`（后者 tracked→adapted）。上游同码亦存此潜伏隐患，修复可上游化。
- 未覆盖仍挂 L9：生产一致备份恢复、LAN/公网双用户验收（8-f）；`--omit=optional` 腿与平台矩阵归 CI（L18）。

**8-e.1 coverage 门禁收口（2026-09-21 复跑全绿）**

- 门禁命令：`DSH_COVERAGE_PARTITIONS=4 DSH_COVERAGE_MAX_WORKERS=6 DSH_COVERAGE_TEST_TIMEOUT_MS=30000 DSH_GATE_CONCURRENCY=3 pnpm run check:ci:coverage`（企业池档参数，macOS 26.6.2 arm64）→ `build:native-system` 0.63s、`test:coverage-exempt-heavy` 102.77s（21138 测试）、`test:coverage` 分区 293.99s（4 分区 1201 文件）三腿全 PASS，合并阈值检查零违规。
- 合并附带损失恢复（上游有、本地 merge 丢）：`vitest.config.ts` coverage.exclude 的 `ptc-runtime-node/process-entry.ts` 条目、`.gitignore` 的 `/dist/` 行、`util/brand/tests/brand.spec.ts`。
- 上游 spec 移植并保留（本地语义兼容）：`ui-primitives` 的 tag/tag-styles/state-dot-styles/use-dismiss-on-outside-pointer/user-text-styles、`tool-bash`/`tool-pwsh` 的 `background-start.spec.ts`（纯逻辑面）；`ui-renderer` invariant spec 按本地 `ctx.provide` 接缝适配落地。另有 23 个上游 spec 引用本地不存在的模块路径或已被本地重构（装配测试 627c0f7、模型控件 cc39423 统一）取代，裁定不移植。
- 本地新增 spec：`core/session` chunk-rows（malformed 守卫与溢出边界）、`apiproxy` assistant-stream（状态机直接覆盖，上游靠集成套件隐式覆盖）、`ui-renderer` invariant。
- 既有 spec 补齐缺口：`llm`（`fileRequestText`、非 Error abort reason 默认文案）、`llm-pi-ai`（`resolveProfiles` 原始输入守卫）、`session-persistence`（`materializeDetached`/`ensureMaterialized` 空会话/`liveStorage`/跨 CWD 同 ID 冲突契约）、`session-persistence-jsonl`（v3 admission 两臂、zstd 输出预算、旧式 PID lease 记录、lease 读失败回退）、`apiproxy` `history-detail`（`sourceEventSeqs` 前向 seq）、`session-query`（非法 `preparedSessionCacheSize`、`observeSession`）、`acp-snapshot`（多代际 harvest 取最高格式代）、`typert/loader`（`pluginPackages` 缺省回退 `bootWithoutResolver`）、`typert/registry`（schema 工厂校验与 context-wire 冲突两臂）、`ptc-runtime-python`（mock `/proc` 的 `readProcessStart` Linux 模拟）、`user-text`（reference-chip 点击回调）、10 个 host 侧空 `apply` 包的 node-half 惯例测试、`plugin-package-inventory`（standing preset mount 分支——`agents.register` 异步落地需等待）、`ui-permission-presets`（catalog `!ok` 拒绝面）、`directory-picker-auto`（entry 挂载中被移除的失败路径）。
- 窄豁免（`v8 ignore`，附不可达理由）：coordinator detached pending-events（公共 append 路径 `deferDraft=false` 直接物化，live owner 草稿前缀随 retire 删除）、catalog-default 的 `finish` fallback 与 `sourceEventSeqs` 内层守卫、session-format `flushBuffered` pending 守卫、`auto-review` 的 `!finished`（本地 `guardTextThinkingStream` 保证 finish chunk，不可达）。平台专属：`subprocess-local/linux-execve.ts` 按 `windowsOnlyCoverageExclusions` 对称模式入 Linux-only 豁免（macOS 无覆盖路径，上游由 Linux CI 腿承担）。
- 抖动修复销 L24/L25：`tools-catalog` 与 `project-doc-site` 抬显式预算到 120s（插桩负载下 30s 默认不足）；`acp-snapshot` 全部 `waitFor` 20ms 断言统一抬 250ms（首个回调在高负载下排不进 20ms 窗，自身错误被 `Timed out` 覆盖）；`gen-client-catalog` 工作区扫描对 oxlint-contract 探针文件的 ENOENT 竞态加容忍（glob→read 间文件消失即跳过）；清出被杀门禁遗留的 `oxlint-contract-*` 探针孤儿与 `.oxlintrc.contract-*` 残留（曾被 tsc 误编进 lib/types）。本轮全量复跑无抖动复现。

**8-e.4 doc-sync 与 hygiene 收口（2026-09-21 收口审查）**

- `verify-persistence-formats`：本地写入器=v4 需补齐 v3 历史工件。从上游 `dsh-v0.1.6-alpha.2`（writer=3，commit `ddefc45f`）源码树经 `extractPersistenceSchema` 提取 v3 库存，产出 `historical-formats/v3.{md,zh.md,schema.json,i18n.yaml}`（61 根/469 类型，含全部摘要的机器声明与区分性特征记录）；格式索引自动刷为 v0–v4 五行。
- `verify-persistence-changes`：v3→v4 类型变迁登记确认记录 `2026-09-21-v4`（decision=version-bump，含兼容性/验证双语 prose：header 收窄、assistant/chunk 移除改内嵌 stream、code-dispatch→ptc-dispatch、内容联合修订）。60 根 ↔ 2 历史记录匹配。
- `doc-typecheck` 真实 API 漂移修复：文档代码块引用 v4 已移除的 `assistant/chunk`（extension-cookbook 两块改走 `agent/assistant-stream` chunk 帧，EN/ZH 同步含 feature-map 行）与已改名的 `CallId`（07-tutorial、llm-adapter 双侧改 `ToolCallId`）。
- `verify-doc-graphs` 8 图重生；`verify-md-links` 2851 文件绿；`verify-doc-budgets`：`testing.md` 新增 spec 执行段致 1290 词超顶，按 relocation-first 原则双语同步压缩至 1198；`verify-repository-references`：`PROJECT-UNDERSTANDING.md`（一次性升级审计报告，含裸 commit hash）迁 `upgrades/`（前缀豁免且语义匹配），`preset-mount-audit` note 裸 hash 改描述性表述（双语）。
- `verify-package-paths`：22 处指向上游未携带路径的 `packages/…` 散文引用按惯例转 `upstream:<group>/<pkg>/...` 非活引用形式，5381 文件绿。
- `verify-translation-pairing`：修 5 处 zh 文档错 locale 链接（`.md`→`.zh.md`），1418 对全绿。
- 生成物：`gen-config-catalog`、`gen-persistence-catalog`、`gen-doc-graphs`、Cordis API catalog（`agent/created` JSDoc 三 `@param payload.*` 合并单标签修坍缩）、`known-event-types.ts` 全部重刷并验证同步。
- hygiene：knip 报的 `dsh-http-proxy` 未用 devDep 属合并漏项——上游 `loader-smoke/index.ts` 三处实质改进未随依赖落地（`clearedProxyEnv` 防机器 proxy 环境污染 fixture smoke、`sourceImport: 'tsx/esm'` 选项、`LoaderSmokeOptions` 的 caller-cwd 复用 union），已整段移植并补 tsconfig `util/http-proxy` 引用；`verify-runtime-closure` 暴露 `cordis` preset 新增 `tool-plugin-manager` 行后 `python/sdk-runtime` 缺 `dsh-plugin-manager`+`dsh-host-plugin-inventory` 传递依赖，已补声明（4 presets + 147 包闭包绿）。
- 收口态：doc-sync 38/40（余 `verify-package-readme-summaries` 256 处、`verify-package-readme-model-experience` 180 处——上游 README 结构语料迁移，7E 车道已记录挂起；**已于 8-e.5 后段全部收口，doc-sync 40/40**）；typecheck/lint/coverage/hygiene 全绿。

**8-e.5 交叉核对终裁（2026-09-21：六维子代理审计 + 逐条亲验）**

- 子代理批次（文件级/组合/依赖/API 面/spec 覆盖/文档六维并行 ≤6）报出的候选缺口全部逐条亲验；误报已排除（`directory-picker-native` spec 双侧一致、`deepseek-flash` 模型名双侧一致、`llm-streaming.md` 上游不存在、docs.ts 的 feedback/attachment 子系统页 alpha.2 上游同样未投影）。
- **真实源修复（spec 移植暴露，非测试问题）**：`agent-presets/mount.ts` 的 `mountDetail` 不识别 cause 包装 AggregateError——移植上游 `detailBranches` 递归缩进展平（嵌套组内失败行现在点名 `inner-first`/`inner-second` 而非止于 group 消息）；`discovery.ts` 的 `compositionProblem` 未兜 package-lookup 异常——补 try/catch 降级为该 preset 的 broken 理由（`the composition's plugins cannot be checked: …`），一个 preset 的查找失败不再中止整个名册列举。
- **移植并全过**：`mount.spec` 五组上游新增用例（inactiveRows 集合 settle 报告、nested-broken 组内归因、packageOf 名册检查两例、无 baseUrl 名册拒绝；夹具 `throws.js`/`nested-broken/` 随拷，harness 补 `PluginPackages`+`builtins.group`，6 处 mkdtemp 接入 roots 清理）53/53、remote.spec 24/24（按本地契约适配见下）、hmr `transport` spec（按本地 `modules.invalidate/prefetch`+`entry.refresh()` 语义重写，jsdom 环境+异步 `fiber.dispose()`）、cordis-client-runner `api-catalog`/`providers` spec（按本地槽位模型重写，120/120）、agent-loop `continuation-messages`/`adapter` spec、`session-log-deepseek` `config` spec（适配本地默认关）与 `feedback-composition` spec（真实 loader 组合，storage 三件套经 namespace import 挂载）、`subagent-codex` `real-product-cleanup` 助手+spec（9/9）。
- **不移植（有意分歧，已核）**：`system-prompt-admission.spec`（in-history admission 语义深度分歧，本地 `systemPromptUpdate` 管线）、`request-freeze.spec`（本地 `freezeRestoredObject` 恢复即深冻属 baseline 硬化，上游 dispatch 才冻——前提不成立）、`WeakMapWithValues`（唯一消费者 `ui-session` 未携带）、`shipped-root.spec`（本地 `profile-boot.ts` derived patch 承接，`shipped-preset-root`/`resolved-profile-boot` spec 覆盖）、`test-session-query.ts` 助手（本地 subagent spec 走"无查询服务"直面路径+内存后端，无 stub 需求）、`serial-created.mjs`（上游 patches 机制在本地 SDK 客户端为 `cordis=` 参数，`serial-listener-review.spec` 覆盖同语义）。
- **agent-presets 语义分歧登记**（本地架构有意面，remote.spec 断言已按本地契约写）：preset remote 对非 RemoteError 一律包装 `gateway/internal`（错误边界不变式 vs 上游原始透传）；blank 判定走 `turnBoundary` 投影（仅 command/plugin 活动的会话仍可切换 vs 上游 `hasConversationContent` 消息内容判定）；无可写根时 `PresetNotWritableError` 携空 preset id（拒绝与 id 无关）；`PresetMountError` 包装 mount 失败（vs 上游逐条 RemoteError）；名册 API 无 `includeShippedRoot`/`modeSelectionEnabled`/`authorable`（`SHIPPED_PRESET_ROOT` 由 profile-boot derived patch 承接，line 127 已记）。
- **session-log-deepseek Config 分歧**：本地 `enabled` 默认 false＋`killSwitch`/`allowlist`/`audit` 为有意硬化面，上游默认 true；config spec 按本地契约适配。
- **矩阵销账**：`packages/e2b/{e2b,fs-e2b,subprocess-e2b}` 上游已自行移除（alpha.2 树无），矩阵行由 adapt 改 `reject`/`not-carried`/`upstreamOnly` 并补 note 记上游移除；`compaction-image-offload`/`session-format-v2-to-v3` 双侧俱在，行有效。
- **session-format-v2-to-v3 `draft` 适配（2026-09-22 补登）**：本地 `SessionHeader.draft`（草稿会话推迟物化，归属 `2026-08-26-session-draft-lifecycle-and-content-watermarks`）是 alpha.1 时代 v3 头既有字段；上游 alpha.2 的 v3 codec 委托 released-v2 键集校验，直接拒收 `draft`。本地 v3 层在解码头/编码头边界先剥离 `draft`、断言布尔、再回写，v2 codec 严格性不变；`upstream-sync.json` 该包分类由 `tracked` 改 `adapted`。同时修复 `ui-conversation` 插件访问 `ctx.remote.permissionPresets` 漏声明 `remote.permissionPresets` inject（catalog 懒源被注入守卫拒绝、权限选择器空渲染），并将 9 份 alpha.1 时代 v2 web 夹具迁移至 released 链承认面（turn/start 弃 `trigger`、step/start 先于 surface、裸 `assistant/chunk` 折入 `assistant/message`/`attempt` 的 `stream`、`sourceEventSeqs`/`messageSeqs` 按投影序号重算、`tool/result` message 补 `id`/`role`/`source`）。
- **session-format-v0-to-v1 `participant` 源适配（2026-09-22 补登）**：项目协作把认证参与者元数据记进 `user/message` source 与 `collaboration-context` 插件源（`participant`/`participantMessageId`，归属 `2026-08-15-project-collaborative-conversations`）；上游 alpha.2 的 released-v0 源词汇无此二字段，PG 持久化真实日志的 v0 边界校验拒收。本地校验器承认两字段并按既有 released 源惯例检查参与者记录必需键；`upstream-sync.json` 该包分类由 `tracked` 改 `adapted`。
- **文档/元数据补齐**：tier-1 发布面（telemetry-otel peer+dev 对位、apiproxy 补 `dsh-scope`/`dsh-session`/`dsh-session-persistence`/`dsh-session-projection`/`dsh-tools`、pi-ai 补 `dsh-fs` peer、benchmarks `dsh-terminal` dev、`tsconfig.host.json` 补 `dsh-http-proxy` 引用并对齐上游序）与 tier-2 测试 devDep（15 包按测试实引补齐，`dsh-client-store` 本地无包跳过）；`glossary` seam 例改上游 `dsh-user-approval`（本地同构，llm 无内置 Consumer）；website docs.ts 补 `dynamic-cordis` 投影条目（order 3）与 wire-extensions repo-only 注释。
- **验证**：agent-presets 172/172、subagent-codex 72/72（含真实 codex 子进程 real-product 7 项）、hmr 6/6、cordis-client-runner 120/120、session-log-deepseek 全量绿；`pnpm install` 解析后 devDep 链接就位。
- **subagent-dsh-sdk 失败诊断层（后续亲验追加）**：上游 alpha.2 在 `run.ts` 落地完整失败分类学（`SdkFailureStage`/`SdkFailureCategory`→固定安全 `Subagent failure (provider: DSH SDK; stage: …; category: …)` 诊断行）——本地基线期拷贝缺失。已移植：`SdkRunFailure`/`failureDiagnostic`/`sdkFailure`（TransportClosed→transport、JsonRpc/Protocol→protocol）、`sdkChildOutcome` 替 `sdkStopReason`（新增 `blocked`→`refusal`、disposed-abort→`child-disposed`、无终末→`missing-terminal`、未知→`child-unknown` 诊断）、`sdkConfigurationFailure`（cwd 解析失败安全包装）、`sdkStartupFailure`（initialize+cleanup AggregateError 拆分）、`internals.createHarness` 测试缝、`collectDiagnostic` 挂进 `settleRunResult`、teardown 包装 shutdown 失败；index.ts 的 `start` 前置 abort 检查 + `resolveChildCwd` 经 `sdkConfigurationFailure`+warn。e2e 同步升级上游三场景（夹具 `scoped-tool-subagent.ts` agent-scope 挂载+`subagent-model-selection-settings` 行、`mock-delegating-llm` 路由选择+resolveModel 记录、`child-mock-llm` RouteEcho 校验+失败模式；本地 `cordis=`/`resolveExampleLaunch`/`DSH_TEST_CHILD_*` env 机制承接上游 patches/dshHome 面）：路由 `mock/mock-routed/max/777`+maxTokens 转发+cwd 继承、子失败诊断与部分输出分离——2/2 + 单元 34/34 全绿；共享夹具 `sdk/client/tests/fake-runtime.ts` 同步升级上游 turn/end 发射块（`none` 真缺省、`FAKE_ABORT_REASON_KIND`、`FAKE_MALFORMED_REASON` 五变体），sdk-client 34/34 无回归。**登记待办**：`subagent-acp` 同型诊断层（`AcpFailureCategory`/`diagnosticText`/`remote-limit` 映射+权限决策诊断）未移植——上游 run.ts 是含 managed-range teardown 的整文件重写（619 vs 367 行），与本地树作用域 teardown 架构分歧，需专项移植协调两种生命周期模型，暂列挂起而非嫁接。**【已收口 2026-09-21】**：诊断分类学按 SDK 同型嫁接入本地 run.ts——`AcpFailureStage`/`AcpFailureCategory`/`AcpFailureFacts`/`AcpPermissionDecision`/`ACP_TOOL_KINDS`/`failureDiagnostic`/`permissionDiagnostic`/`diagnosticText`/`AcpRunFailure`/`acpConfigurationFailure`/`permissionRequestKind`/`startupFailure`/`terminalFailure`/`reportFailure` 全量移植；`latestPermission` 追踪挂进 onRequest；prompt 成功路径接 `terminalFailure`（max_turn_requests→remote-limit+stop reason、未知原因→unknown 固定回退不含原文、max_tokens/refusal/cancelled 携权限事实）、失败路径经 `settledOutcome` 有界观察（done 已 settle→`stage: process; process-exit`+退出码/信号，live→`transport`）；startup 失败按 `startupStage`（initialize/new-session）分类并经 `AcpRunFailure` 安全包装（配置 cwd 失败→`stage: initialize; configuration`，session id 缺失→`new-session; protocol`，spawn/done 失败携 `process-exit` 退出码）；dispose/teardown 失败同款包装。managed-range teardown 本体不移植（架构分歧维持）。夹具补 `MOCK_PERMISSION_IGNORE_DECISION`/`MOCK_TOOL_KIND`/`MOCK_CRASH_ON_INITIALIZE`/`MOCK_CRASH_AFTER_CHUNK`；spec 补 `expectedFailure`/`expectedPermission` 助手 + 既有断言 diagnostic 字段 + 6 个新测试（权限事实×2、cancelled 无诊断、remote-limit、未知回退、crash-after-chunk process-exit、initialize process-exit）——54/54 绿 + loader-composition e2e 绿。

**8-e.5b README 语料迁移收口（2026-09-21：7E 挂起解除）**

- 上游 alpha.2 的包 README 结构（`## Summary` + 规范 `## Model Experience` + zh `## 概述`/`## 模型体验`）此前整体未迁，挂为 7E 语料项（summaries 256 处 + model-experience 180 处违规）。本轮按"节级拼接保留本地自有内容"原则全量收口：**doc-sync 40/40 全绿，两门禁不再有余项**。
- **节级移植**：239 个上游对齐文件经脚本提取上游 `## Summary`/`## 概述`（230 处新增）与 `## Model Experience`/`## 模型体验`（189 处长式节整段替换为上游规范版），位置按"引言块之后、首个 `## ` 之前"归位；无 `## ` 标题的组 README 双侧统一置于文末。
- **分类学补齐**：`SENTENCE_MODEL_EXPERIENCE` 表补 6 个上游已审条目（browser-use、computer-use、ui-schedule、browser-use-runtime、deepseek-llm-api-extensions、session-turn-outline）；`util/values` 按上游裁定移入 `NO_MODEL_EXPERIENCE_SECTION`（整节省略）；`session-format` 保留上游长式节、删本地多余 none 分类。19 个本地分类包按表理由写规范短式句（`None, as …`/`Indirectly, through …` + `#### KV Cache effect`，双语）。4 个本地包长式节的 `**Runtime invariant:**` 游离段按惯例移入 `## Known Limitations` 节末，解除字段后非法段落违规。
- **本地独有包手写**：26 个无上游文件的包（client/ui-*、collaboration、userdoc 系、gateway-runtime、archive-gateway、apiproxy、userdoc-http、model-access、model-provider-config、session-persistence-gateway/-sqlite、acp-snapshot、examples 组）按 dsh-doc 模板手写 `## Summary`/`## 概述`（≤100 词、用户视角）；`host/open-in-app`、`client/ui-open-in-app`、`util/http-proxy` 三个超长既有摘要压缩至限内（双语）。
- **附带损伤修复**：zh 文件 7 处残留英文 `## Model Experience` 节清除（与新插 `## 模型体验` 并存致标题深度错位）；节级手术误吞的 6 个 `<a id>` 锚点（`known-limitations-and-deferred-work`×4、`confinement-error-indirectly`、`settlement-notice`）与 2 个 `**运行时不变式：**` 段按 HEAD 原位恢复；`tool-agent-team` zh 补同款 `<a id>` 锚；`tool-userdoc` zh 补手写 `## 模型体验` 三节长式翻译；ui-deliverables 上游 `tool-present` 死链改纯文本。
- **门禁终态**：`verify-package-readme-summaries` 331/331、`verify-package-readme-model-experience` 279/279（125 structured + 224 model-context entries）、`verify-translation-pairing` 1421 对、`verify-md-links` 2857 文件、`verify-doc-budgets` 9/9（`packages/README.md` 按 relocation-first 压缩至 986）、doc-sync 40/40。`verify-package-readme-summaries` 的 spec 同步保留——迁移后该门禁成为常设护栏。
- **验收协议物化**：仓库内不可收口的 8-f/L18/L9/L4/L7/Q4 已整理为可执行验收手册 [ACCEPTANCE-RUNBOOK.md](ACCEPTANCE-RUNBOOK.md)（双语）——每项含前置条件、步骤、通过判据与 Evidence 表；行转 `done` 需证据填齐并同步更新台账行。

**8-e.5c 二开功能交叉验证与缺陷收口（2026-09-21：六路只读审查 + 逐条修复）**

六路只读子代理（ACP 诊断嫁接、SDK 诊断层、agent-presets、夹具/ spec 完整性、client/workbench diff、core/session/api diff）+ 本地门禁复跑。确认二开主体健康的同时发现并修复以下真实缺陷：

- **门禁红（提交态）**：`providers.client.spec.ts` 的 `provider().query()` 缺第三个 `ClientCordisInspectQueryContext` 参数（7 处编译错）与 `transport.client.spec.ts` 的 `Loader` 误从 `@deepseek-ai/cordis` 导入（应在 `cordis-plugin-loader`，连带 oxlint 不必要断言错误）——vitest 不做类型检查故测试绿但 `pnpm run typecheck`/`lint` 红。已修复并按本包惯例 `'x' as SessionId` 品牌断言。
- **client/runtime `sessions/pool.ts`**：`handleConnected` 把 archived 会话集写死在 `'personal'` 键，而 `setBaseRuntimeTarget` 把 base entry 重键为 `'project:<id>'`（workbench 项目页可达）→ 重键后 archived 过滤永久为空、已归档会话残留列表。修为按当前 entry key 写入 + 重键时迁移 archived 集 + 补 fire-and-forget 的 rejection 臂（453/453 无回归）。
- **sdk/client `api.ts`**：`DeepSeekHarness.start()` 在 initialize 失败且 `close()` 也失败时让 cleanup 错误整体吞掉 init 错误——移植上游同款 `AggregateError([error, cleanupError])`（`sdkStartupFailure` 的聚合臂因此可达）；同文件补上游 `validatedTurnEndReason` + `validatedSessionEvent` 的 `turn/end` 校验分支——wire 侧畸形 abort 原因/缺 data 的终末事件不再以 TypeError 漏进 `sdkChildOutcome`，统一 `SdkProtocolError`→`protocol` 诊断。subagent-dsh-sdk spec 补 3 个 wire 级用例（malformed aborted/no-data→protocol、disposed-abort→child-disposed），37/37 绿。
- **subagent-acp `run.ts`**：`spec.spawn()` 同步抛错裸传——按上游包 `AcpRunFailure({ stage:'process', category:'process-start' })`（'process-start' 类别不再是死成员）。
- **agent-presets `mount.ts`**：`inactiveRows` 一次性 `tree.entries()` 快照漏审组内组迟注册行（死行可挂为健康）且数字形 entry id 破坏父先子后序（健康 preset 误报 never started）——前置 `await tree.await()`（循环 getTasks 至静默，缺失 inject 的 fiber 无 inertia 不挂死）；`detailBranches` 只剥一层 cause——改全链 cause 遍历收集全部 AggregateError 成员 + `mountDetail` 递归带 seen 集防循环错误图；`index.ts` `ensureStanding` catch 裸 `standing.delete` 可误删新一代指针——同款 guarded delete（`=== created`）；`v8 ignore` 陈旧理由修正（registry.plugin 失败确实产生 fiberless enabled 行）。
- **夹具/测试修复**：`fake-runtime.ts` 删死开关 `FAKE_STATUS`（wire 无 `session.finished`，3 个 spec 传它以为在脚本化状态）+ 头注术语修正（`session.finished`→`turn/end`+`session.status`、`accepted`→`messageId`、裸 reason 值 `'not-a-reason-envelope'`）；`mock-acp-server.ts` 头注补 9 个未记录 env + 孤段落归位 `MOCK_PERMISSION` + `selected` deny 保真注记；`remote.spec` 删 `swap` 从不调用的 `stateOf` 死 mock（测试更名为如实断言）；`mount.spec`/`remote.spec`/`subagent-acp.spec`/`subagent-dsh-sdk.spec` 全部补 `contexts` 注册表 + afterEach 统一 dispose（对齐 `composition-inventory.spec` 惯例）；`transport.client.spec` 补换绑路径用例（registry 先删→inertia drain→fiber 清除→refresh）与 invalidate→prefetch 顺序断言；`providers.client.spec` 的 slots stub 记录 `snapshot(root)` 参数并补 `available:false` 分支；`api-catalog.ts` 重复 `timer` 条目——生成器级修复：`gen-cordis-inspect-catalog` 的客户端投影覆写 `runtimeServices: []`（本地 client face 有真实浏览器 `ctx.timer` TimerService，上游无此服务故无碰撞；curated host 侧条目不再与发现的浏览器条目同键并存，上游对齐一计时器条目）；`nested-broken` 夹具与 `two-broken` 测试注释按实际失败路径（discovery 检查/per-fiber FAILED）修正。
- **文档漂移**：`subagent-dsh-sdk` README 停止原因映射更新（`blocked`→`refusal`、disposed-abort→`child-disposed`、diagnostic 字段，双语）；`session-persistence-jsonl` README 删 11 个已失效配置项（coordinator 时代残留：packChunks/writeBatchMaxDelayMs/maxPending* 等，schema 仅 `{root, compression}`）、packed-row 段重述为 v0/v1 历史 codec 事实、"迁移到当前 v3"改 v4、写路径"配置的固定批处理窗口"改 seam 内部调度（双语）；`acp-demo` 删死配置 `packChunks`（字段+schema+转发+README 行），config-catalog 重生；`core/session/chunk-rows.ts` 头注 "Released-v3" 改 "Released-v0/v1"（v2/v3/v4 写入端从不打包）。
- **如实登记未修（LOW/观察项）**：`discovery.ts` group 行自身 `name` 不查 + `disabled` 语义与 loader 分歧（group 行的 disabled 在挂载期被忽略）；`internals.createHarness` 测试缝本仓暂无消费方（结构随上游保留）；`fakeLaunch` 透传 `process.env` 使环境 FAKE_* 可泄入 fake 脚本；`index.ts` `%o` 对 plain Error 渲染 `{}`（SDK 同款惯例，保留一致性）；`settledOutcome` 一宏任务窗的 transport/process-exit 分类竞态（代码注释已声明）；`gateway/server.ts` `/account/api/projects` 的 `canManage` 未计 `authority.administrator`（未发现消费方）；`api-catalog` spec 的 `referencedTypes` 仅查数组形态。
- **验证**：全量 typecheck/lint 绿；受影响 spec 全绿（client-runtime 453、cordis-client-runner 120、agent-presets 172、subagent-dsh-sdk 37+34、subagent-acp 54、hmr 7）；`doc-sync` 维持 40/40。

## 本轮补全批次 0（2026-09-22）

本轮实施基线为 `aa98a628f4e0e41316af25279c5d922f4bd7b5cd`，分支为 `codex/alpha2-complete-alignment`，上游目标仍固定 `ddefc45fbc7f8e46dd73185e68295696d1297887`。顶层状态为 `implementation-in-progress`，继承全部已批准阶段及产品决定；记录修复没有把新候选、后续 UI/能力补全或发布验收标为完成。此前各节保留对应时点的历史记录。

当前矩阵和清单升级为 schema v3；冻结的 alpha.1 记录保持原样。矩阵消除 4 组同 area 的 `required`／`adapt` 冲突，按现有代码归入 `adapt`，累计与增量原始路径仍归其实际消费者 owner，审查状态全部保留 pending。

| area | 累计原始路径 | 增量原始路径 | 单独保留的历史归一化别名 |
| --- | --- | --- | --- |
| `packages/ptc-runtime/ptc-runtime` | 18 | 1 | 0 |
| `packages/ptc-runtime/ptc-runtime-node` | 52 | 6 | 5 |
| `packages/experimental/ptc-runtime-python` | 31 | 1 | 0 |
| `packages/workflow/workflow-ptc` | 50 | 1 | 6 |

按 `git diff --no-renames --name-only -z` 对账，补回 76 个被旧 code-runtime／workflow-worker-thread 路径归一化掩盖的真实变化路径，消除 9 个同一行内的重复路径引用，并把不属于真实 diff 的 11 个历史归一化路径移入各 owner 的 `historicalPathAliases`，保留原始 `sourcePath` 和 alpha.1 来源记录。最终 329 行逐一认领累计 5,507 路径、增量 2,641 路径，无缺失、多余或重复；其中 320 行待累计源码审查、9 行保留既有本地验证状态。路径与旧名归属一致，无需为了计数新增 area。

[记录检查器](../../scripts/verify-upgrade-records.ts)对 schema v3 拒绝重复 area、重复 decision id、缺少对应身份字段、原始路径漏项／多项／重复认领和错误摘要计数。重命名的删除与新增路径分别对账，历史别名不能代替实际变化路径。当前同步目标要求 schema v3 或更新版本，不能通过降级字段绕过校验；较早目标的 schema v2 及更早记录继续使用其历史解释，没有重写历史来满足新格式。[回归测试](../../scripts/verify-upgrade-records.spec.ts)通过临时 Git 仓库运行真实 CLI，覆盖含中文文件名的重命名、累计和增量缺口、无效重复身份及历史兼容。新增身份与库存拒绝用例在修复前均观察到未被阻断；修复后 35 项测试通过，真实仓库入口校验 16 份记录通过。

[CI 输入准备入口](../../scripts/fetch-upstream-baseline.ts)读取当前矩阵的累计与增量基线提交，校验完整 SHA 和一致的目标固定值，仅从固定公开上游以 `--depth=1 --no-tags` 补取缺失快照。已有但身份不符的 tag 会失败而不被覆盖，输入不可取得时不能跳过对账。[直接测试](../../scripts/fetch-upstream-baseline.spec.ts)使用真实浅 Git 仓库和本地传输，证明两个缺失比较提交被取得、较早的未请求祖先仍不存在、再次执行不 fetch、非法／缺失 SHA 和错误 tag 被拒绝。6 项测试通过；连同记录检查器共 41 项。实际执行现有 CI 顺序 `node scripts/fetch-upstream-baseline.ts` → `node --import tsx/esm scripts/verify-upgrade-records.ts`，3 个固定比较树就绪，16 份记录通过。这里没有新增工作流或全量历史拉取。

GitHub API 核实 [CI 35688456271](https://github.com/jsjm1986/CoHarness/actions/runs/35688456271)的 `head_sha` 为 `2ba86fcbb908dd90226dbf5a62148099d24d6607`，完成于 `2026-09-22T05:12:36Z`，结论 success；`node 24 / coverage` 的 `Run exhaustive coverage` 步骤成功，执行 `pnpm run check:ci:coverage`。该次共有 15 个 job 成功、11 个 skipped，原生 Windows complete、macOS serial、manual full audit、可选 Android 等未运行。清单因此修正“从未运行”的陈述，同时保留当前候选 `pending`：旧 CI、不带提交身份的旧命令记录及仅有汇总状态都不能作为本轮发布通过证据。

## 本轮补全的局部实现与验证（2026-09-22）

以下记录对应 `codex/alpha2-complete-alignment` 的局部实现，不关闭整项产品决定或累计源码审查。最终候选、GitHub CI、真实 Provider 和平台验收仍待完成。独立提交 `f599b9fca0` 固定批次 0 校验；`c7a95773d7` 修复 ACP 清理；`974ad9a198` 修复草稿 Session 读取。

| 改动 | 本地承接与保留差异 | 已执行的局部证据 |
| --- | --- | --- |
| Profile 管理授权 | `boot/plugin-manager` 所有公开操作与工具共用部署授权，排队后重验；Gateway 实时读取有效管理员资格。独立本机仍按本机权限执行。该包登记为 adapted，不再 unmanifested。 | 89 项 owning package 回归；3 个指定源文件四维覆盖率 100%；真实 PostgreSQL＋HTTP 证明过期前的旧管理员断言在降权、禁用后被拒绝。 |
| 跨 Gateway 撤权 | 同事务 outbox、按节点确认游标、代理和文档下载取消；事件发布重验 ACL。下载的 EOF／取消共用释放结果，失败不确认撤权；不宣称收回已发送字节。 | 真实 `test:postgres` 两套件 42/42（25 项基线、17 项撤权）；既有文档传输／server／proxy 55/55，API 515/515，纯 Node 构建产物 mux／Host smoke 2/2。上游运行时仍是受控传输夹具，不替代完整多用户产品验收。 |
| ACP 清理 | `subagent-acp` 的退出观测失败不能跳过终止与最后退出等待，错误保留。 | 60 项包测试；真实子进程负例先失败后通过；构建后的 Loader 场景通过。 |
| 文件计价 | `token-meter` 接入普通文件事实与实际文本请求长度，保留本地不可变折叠和缓存。 | 79 项包测试、135 项 compaction 回归；3 个源文件四维覆盖率 100%，退役 `route-pricing.ts` 的覆盖率排除。 |
| 草稿恢复 | 当前格式读取器保留 writer 已有的 boolean `draft` 字段，不新增格式代次，也不重写已提交文件。 | 507 项持久化测试；真实 Steer 场景和构建后迁移 smoke 通过。 |
| 运行中发送 | 鼠标与 Enter 使用同一 Queue／Steer 偏好；保留本地输入、上传、命令及 Stop 行为。 | 153 项源测试；真实 Queue／Steer、设置与持久化验证。 |
| 模型菜单 | 上游键盘和 portal 行为接入治理数据源；保留手机 Settings Sheet 及原触控尺寸。 | 40 项源测试；真实 Web 4/4，390／375／320 手机几何 golden 未变。 |
| 工具 diff／终端 | 上游有界 diff、准确增删数及未知退出状态接入现有工具卡片；保留本地 8 行预览。 | 真实 `read/edit`、文件字节及持久结果验证；精确 diff 与 130 删除／130 新增／0 上下文场景均通过。bounded golden 仅适配 8 行上限引起的两行变化。 |
| 思考正文 | 上游紧凑 Markdown 进入现有 Think 行；保留摘要节流，不截断展开正文，折叠按钮保持可达。 | 115 项相关组件与 Markdown 回归；长流式内容保留首段、全部 900 段及后续追加；实际 Web 生命周期 7/7、会话往返 7/7。 |

真实 Web 验证使用现有 keyless replay 及实际产品、工具和文件操作；它不等同于真实 DeepSeek Provider、GUI 发布演示或 Gateway 多用户验收。只调整对应 owner 的期望和断言，没有全量重录 a11y 快照。共享录制输入通过现有 `web-test-policy.sharedInputs` 登记全部 owner，引用不存在时失败；未来整合 #219 时必须保留这些 owner 与共同 smoke。

插件管理的请求级授权只是完整发起人传播的基础。共享会话中的混合人工输入、排队及恢复工作的真实身份、Auto 资格和子 Agent／PTC 传播仍未验收；不能用仍然有效的某个管理员请求上下文代表另一个参与者的权限。跨 Gateway 断流、下一次请求拒绝和目录授权进程重建也不能代表共享 runtime 中所有既有模型／工具任务都已停止。这些差异继续阻止相应产品决定被标为完成。

SessionReference、batches／ClientEntries、统一右侧标签、D7、SSH、用户终端、Browser、Office、Webhook、完整 Admin、桌面执行授权、外部 Team、部署迁移及最终平台／产物验收仍按已批准计划实施。上述局部证据不将它们转为通过，也不将旧提交的 CI 结果转移到新候选。
