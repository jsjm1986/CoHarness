# 上游对齐审计 — dsh-v0.1.6-alpha.2

## 目标调整依据

- 本轮目标由 `dsh-v0.1.6-alpha.1`（`0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`）调整为 `dsh-v0.1.6-alpha.2`（`ddefc45fbc7f8e46dd73185e68295696d1297887`），发布页 https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2（2026-09-17 发布，prerelease）。
- 证据来源：GitHub compare API（`0a15e36e...ddefc45f`：`total_commits` 887、300 个返回文件页）与 recursive git/trees 全树 blob 比较。2026-09-18 以本地拉取的上游 tag 复核：`git diff --name-status --no-renames dsh-v0.1.6-alpha.1 dsh-v0.1.6-alpha.2` 为 2,641 个变化文件（901 新增、57 删除、1,683 修改），累计 rc.2→alpha.2 为 5,507；新增包 9、删除包 1（`fs/tool-present` 实为迁移到 `deliverables/tool-present`）；`packages/session/session-format/src` 无变化。首版库存多计 2 个路径，原因是本地 `git ls-tree` 默认对非 ASCII 路径加引号转义而 GitHub trees 返回原始 UTF-8，`snapshots/web/present/workspace.expected/说明.txt`（三个 tag 内容相同）被同时计为删除和新增并生成一行伪行；矩阵已删除伪行并以 `core.quotePath=false` 对账。alpha.1 是 alpha.2 的直接祖先（merge-base 即 alpha.1），增量可与累计线性叠加。这些是范围证据，不是逐文件语义审查。
- alpha.1 的实施与验收历史保留在 [alpha.1 计划](../../plans/UPGRADE-PLAN-dsh-v0.1.6-alpha.1.md)、[alpha.1 审计](UPSTREAM-AUDIT-dsh-v0.1.6-alpha.1.md)及对应清单/矩阵中，不并入本文件。

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

- 矩阵 333 行全部标注 `localSovereignty`（`scripts/upstream-sync.json` 与 upstreamOnly 清单）：adapted 227、replaced 2、tracked 3、upstreamOnly 35、unmanifested 32（上游新包，在各自阶段决定携带并登记）。
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
- 7E：`verify-client-ui-i18n`（332 处违规是全客户端本地化改造，ui-trajectory 130+、ui-primitives 40+；`ui-message-feedback` 的诊断码字面量已按修法修正）、`verify-package-readme-summaries`（295 处缺 `## Summary`）、`verify-tsconfig-paths`（＋gen）、`verify-subsystem-pages`（5 个新包缺归属链接）、`verify-application-entrypoints`（4 处入口分类）、`verify-concrete-terms`（43 处 `provenance` 与上游术语重命名同源，随 2B/7E 对齐清除）。

**拷贝后评估为耦合过早、已撤下待阶段重拷**：`verify-default-product-isolation`（依赖上游 `verify-client-packages.ts` 新增导出，7E 随该文件上游变化一并带入）、`benchmark-next-package-dependency`（同上）、`browser-bundled-externals`（依赖上游 `apps/web/product-isolation.ts`，7E）、`session-snapshot-corpus*`（依赖未携带的 `dsh-session-snapshot` 包，随该包进入阶段）、`snapshot-spill-locators`（依赖上游 `SpillSource.kind`，随 spill 包升级阶段）、`test:expected`／`test:docs`（依赖上游 `doc-quick` 车道与 expected 语料，7E 评估与本地 `test:snapshot` 对应关系后定）。

**不适用（上游专属，不拷贝）**：`issue-management`、`preview-sizing`、`review-ownership` blame 权重、`e2b-e2e.yml`（上游已删）、desktop/inspector 门禁、`apps/desktop` 相关 CI 步骤。

doc-sync 车道现状：31/31 通过，含三个新接门禁（npm dependency catalog、repository references、cordis inspect catalog）。

## 本审计的边界

- 尚未完成 2,641 个变化文件的逐文件语义审查，未完成逐提交归属；矩阵行与清单决定只声明范围与待验证要求，不声明实现完成。矩阵 333 行中只有 `apps/desktop`、`apps/desktop-host` 两行为用户确认路由，其余仍为初始路由。
- 本地规划检查点 `6f0ec56328` 与上游 tag 无祖先关系；树差异不证明等价。
- alpha.1 遗留的未验证项、环境阻塞、不稳定用例与观察项集中在下表，共 23 项；alpha.1 记录中没有独立枚举清单，本表由 alpha.1 审计各批次的"未验证／待完成"陈述与 alpha.1 Phase 1/2 代码审查逐条整理。换目标不清空欠账；销账须记录验证提交、命令与环境。

## 未验证与环境阻塞台账

| 编号 | 项 | 类型 | 来源 | 承接阶段 |
| --- | --- | --- | --- | --- |
| L1 | `pnpm run test:coverage` per-file 100% 从未对 Phase 1/2 源码执行；coverage 分片 3/3 曾被主动终止 | 未验证 | alpha.1 审计"Phase 1：Node 内部加载器依赖"、两处收口 | 1B、2B 首批前收口 |
| L2 | 真实 provider e2e：DeepSeek 双协议、BYOK 与组织代理路由、凭据归因 | 未验证 | alpha.1 审计各批 | 3A |
| L3 | 组装快照未覆盖 Messages、图片、PTC 新面 | 未验证 | alpha.1 审计"Phase 2 收口" | 3A、3B、4A |
| L4 | Python SDK 打包产物仅 macOS arm64 carrier 冒烟通过，Linux/Windows 产物未验 | 部分验证 | alpha.1 审计"Phase 2 收口" | 8 |
| L5 | 跨平台原生验证（Linux/macOS/Windows；vendor 同步、subprocess、sandbox、landlock） | 未验证 | alpha.1 审计"Phase 1：Node 内部加载器依赖" | 4B、8 |
| L6 | 独立 Gateway 与树外治理插件业务回归 | 未验证 | alpha.1 审计"旧启动事件移除与全量验收" | 2B、7A、7D |
| L7 | 桌面能力验收（computer-use、browser-use；GUI 主机权限） | 未验证／缺环境 | alpha.1 审计多批 | 5、6A（Q4） |
| L8 | LAN/公网真实双用户验收 | 未验证／缺环境 | alpha.1 审计多批 | 6B、7B、8 |
| L9 | 生产迁移演练、一致备份恢复、发布闭包与健康证据 | 未验证 | alpha.1 审计各收口 | 8 |
| L10 | 原生 watcher `EMFILE`（errno -24，软／硬限额 unlimited 仍复现） | 环境阻塞 | alpha.1 审计"非事务 Loader 适配（过程批次）" | 1B 迁移后复测；8 部署前提 |
| L11 | 宿主 Python 3.9.6 低于 3.10，`code-runtime-python` 两个测试文件失败，测试以 3.12 绕过 | 环境阻塞 | alpha.1 审计"干净基线测试" | 8 部署前提 |
| L12 | `session-persistence-jsonl/tests/lease.spec.ts` 全量并发下失败、隔离通过 | 不稳定 | alpha.1 审计"实施后全量复跑" | 2B |
| L13 | ACP 子任务／标题等待超时偶发，修复保持原期限 | 不稳定 | alpha.1 审计"旧启动事件移除与全量验收" | 2B、7A |
| L14 | Python runtime 清理耗时 4074ms 超过 4000ms 偶发；输出上限预期得到 timeout | 不稳定 | alpha.1 审计"串行创建与启动 hooks"、"Node 内部加载器依赖" | 4B |
| L15 | 快照请求数 2 而非 1 偶发，原因未定 | 不稳定 | alpha.1 审计"串行创建与启动 hooks" | 2B |
| L16 | Claude/Codex hooks、Landlock 后台分类 5 秒超时偶发 | 不稳定 | alpha.1 审计"非事务 Loader 适配收口" | 2B、4B |
| L17 | `watch-config.spec.ts` 首次配置添加未生效偶发，隔离通过 | 不稳定 | alpha.1 审计"Node 内部加载器依赖" | 1B 迁移后复测 |
| L18 | CI 必需任务（平台矩阵、windows-wine、coverage lane）未在本地或分支执行 | 未验证 | 计划证据要求 | 8 |
| L19 | `Fiber.update()` 返回 void 后，运行期配置更新失败只留在 fiber `_error` 与日志，无等价于启动路径的审计 | 观察项 | alpha.1 Phase 1 代码审查 | 1B |
| L20 | 串行 `agent/created` 监听器顺序为隐式注册顺序，无显式编排 | 观察项 | alpha.1 Phase 2 代码审查 | 2B |
| L21 | `tool-cordis` api-catalog 的 `agent/created` 参数描述缺 `agent`／`source`，goal `resume` 描述有语法错误 | 观察项 | alpha.1 Phase 2 代码审查 | 7D |
| L22 | 上游 profile-resolution／required-startup 策略在 alpha.1 推迟至发布闭包 | 推迟项 | alpha.1 审计"非事务 Loader 适配收口" | 1B（alpha.2 runtime 解析直接覆盖） |
| L23 | Session 迁移链拆为上游 `session-format-*` 独立包的可选结构对齐 | 推迟项 | alpha.1 计划 | 7E 可选 |

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

**撤下待阶段重拷（e2e 依赖未落地 API，不造假）**

- → 2B（session-format `generationLogFilename`/`JsonlCompression`）：`session-format-guard.expected.e2e.ts`
- → 3A/2B（`dsh-session-snapshot` 依赖 `llm-replay`/`session-format` 未带导出）：acp 7 件（acp/cleanup+helper/control-surface/escalation/goal/hooks/image-offload）、headless 5 件（headless/semantic-checkpoint/subagent-diagnostic/subagent-inheritance/workspace-context-resume）
- → 4A（`ptc-runtime-node`）：`ptc.e2e.ts`
- → 7A（`WebBootGraph.batches`）：`runtime-roster.ts`/`runtime-roster-observer.ts`/`default-web-process.ts`/`web-default-isolation.expected.e2e.ts`
- → 7B/7D（`@modelcontextprotocol/*@2.0` fixture `calls`）：`creator-plugin-manager.expected.e2e.ts` + fixture mjs
- → 7E（`agent-presets.SHIPPED_PRESET_ROOT`/`modeSelectionEnabled`/`SettingsNamespace`）：`web-agent-presets.e2e.ts`
- `packages/test-support/session-snapshot` 包整体不落地（级联缺 `prepareSessionSnapshotFixtureForComparison`/`parseSessionFormatLogFilename`）

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
