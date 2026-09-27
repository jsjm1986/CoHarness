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
- 7E：`verify-client-ui-i18n`（332 处违规是全客户端本地化改造，ui-trajectory 130+、ui-primitives 40+；`ui-message-feedback` 的诊断码字面量已按修法修正）、`verify-package-readme-summaries`（295 处缺 `## Summary`）、`verify-tsconfig-paths`（＋gen）、`verify-subsystem-pages`（5 个新包缺归属链接）、`verify-application-entrypoints`（4 处入口分类）、`verify-concrete-terms`（43 处来源字段名与上游术语重命名同源，随 2B/7E 对齐清除）。

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
| L1 | `pnpm run test:coverage` per-file 100% 从未对 Phase 1/2 源码执行；coverage 分片 3/3 曾被主动终止 | 已验证 | alpha.1 审计"Phase 1：Node 内部加载器依赖"、两处收口 | 8-e.1 销账：`check:ci:coverage` 分区模式三腿全绿（4 分区 1201 插桩文件 + exempt-heavy 21138 测试，合并阈值零违规），缺口清单逐项收口详见 8-e.1 节 |
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
| L18 | CI 必需任务（平台矩阵、windows-wine、coverage lane）未在本地或分支执行 | 未验证 | 计划证据要求 | 8 |
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
- → 7A：`WebBootGraph.batches` 与 `ClientEntries` 已在 2026-09-23 的隔离工作树采用，`runtime-roster.ts`/`runtime-roster-observer.ts`/`default-web-process.ts`/`web-default-isolation.expected.e2e.ts` 已恢复；Host 与浏览器从实际注册表验证默认产品隔离，并用测试专用实验插件证明检查能拒绝污染。保留 CoHarness runtime 预加载、鉴权、Workbench 与插件分组，见[页面级条目说明](../../.agents/notes/implemented/architecture/2026-09-23-page-owned-client-entries.md)。此项完成不代表 Session 引用、整个 7A 或最终候选已验收。
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
- **agent-presets 语义分歧登记**（本地架构有意面，remote.spec 断言已按本地契约写）：preset remote 对非 RemoteError 一律包装 `gateway/internal`（错误边界不变式 vs 上游原始透传）；blank 判定走 `turnBoundary` 投影（仅 command/plugin 活动的会话仍可切换 vs 上游 `hasConversationContent` 消息内容判定）；无可写根时 `PresetNotWritableError` 携空 preset id（拒绝与 id 无关）；`PresetMountError` 包装 mount 失败（vs 上游逐条 RemoteError）；名册 API 无 `includeShippedRoot`/`authorable`（`SHIPPED_PRESET_ROOT` 由 profile-boot derived patch 承接，line 127 已记；`modeSelectionEnabled` 已由 B6 增量落地——注册进 `projectWritePaths` 成为项目管理者策略，个人部署下保持上游个人设置语义，见收口台账 B6 段）。
- **session-log-deepseek Config 分歧**：本地 `enabled` 默认 false＋`killSwitch`/`allowlist`/`audit` 为有意硬化面，上游默认 true；config spec 按本地契约适配。
- **矩阵销账**：`packages/e2b/{e2b,fs-e2b,subprocess-e2b}` 上游已自行移除（alpha.2 树无），矩阵行由 adapt 改 `reject`/`not-carried`/`upstreamOnly` 并补 note 记上游移除；`compaction-image-offload`/`session-format-v2-to-v3` 双侧俱在，行有效。
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

## 7A 启动与插件生命周期增量（2026-09-23，未提交候选）

本批在 `codex/alpha2-complete-alignment` 隔离工作树实现，保留正在进行的主线合并检查点；尚未提交、推送或开放发布。采用目标 tag 的启动批次、ClientEntries、图事件和局部重试，保留本地 Workbench、认证接线、runtime 预加载及插件分组。生产环境保留图传输，仅文件产物轮询需要显式开发配置，见[页面级条目说明](../../.agents/notes/implemented/architecture/2026-09-23-page-owned-client-entries.md)。

- 启动、条目、传输及组合守卫的 144 项聚焦用例通过。新增 entries、entry-lifecycle、events 三个实际测量文件的逐文件覆盖率为 100%；这不代表已有覆盖率欠账文件也达到 100%。
- [真实插件生命周期](../../apps/web/tests/client-plugin-live.e2e.ts) 5 项、[默认产品隔离](../../apps/web/tests/default-product-isolation.e2e.ts) 1 项、[设置页](../../apps/web/tests/settings-chrome.e2e.ts) 9 项、[真实 HMR](../../apps/web/tests/hmr-live.e2e.ts) 1 项通过。默认隔离含主动挂载实验插件的负例；主题加载测试拦截实际启动图声明的 application 批次。
- [四窗格回归](../../apps/web/tests/workbench.e2e.ts)覆盖并发流、审批、草稿恢复与后台完成；[文档管理](../../apps/web/tests/document-manager.e2e.ts)覆盖桌面、窄屏、跨作用域和上传，共 11 项通过。使用既有预期输出只读回放，没有扩大 normalization 或批量重录。
- Web 夹具显式隔离文档目录，避免测试访问操作者默认目录。相同本机、相同 5 个插件生命周期场景的用例耗时合计由约 152 秒降至约 11 秒；这是本次本机对照，不是 CI 中位数、跨平台性能或全仓提速结论。
- 隔离调查发现孤儿准入锁恢复检查 `.admission`，真实工具却持有 `.admission.lock`；修正负例在旧实现下约 30 秒失败，旧构建经真实 HTTP 返回 500。修正路径、串行恢复并重新核验所有者后，文档存储与原子写共 142 项回归通过；[真实组装](../../apps/web/tests/scaffold-hermetic.e2e.ts)的文档隔离、技能隔离与后端重启恢复 3 项通过。不能证明进程退出的锁保持不动，恢复协调锁中断后的操作员处理边界见[恢复说明](../../.agents/notes/implemented/bug-fix/2026-09-07-userdoc-orphan-admission-lock.md)。
- 完整构建、后续 Host 增量构建、Host 类型检查、受影响源码严格 lint、升级记录校验和双语配对已执行。门禁接受与拒绝用例保护生产图传输和轮询配置；上游接入点重放记录保留执行器三态与既有调度关系。

本批不关闭 SessionReference、导航代次、统一右侧栏、SSH、终端、Office、Webhook、完整 Admin、真实 DeepSeek 与最终跨平台验收。现有 pending 项不得根据上述局部绿灯批量改为完成，发布验收基线仍待最终候选。

## 7A：Client Session 显式引用增量（2026-09-23）

本地 `client/runtime` 接入 alpha.2 的 `SessionTarget`、`SessionReference`、`retain/using/retainInfo`，保留 CoHarness 的选择与 Workbench 适配器，但这些视图通过同一分配器持有引用。读取 binding、scope 或引用统计不创建资源；最后一个引用释放后拆本地历史与 scope，不取消 Host Agent。作用域事件与 `sessionOf()` 按确切代次解析，Typert 发起身份不接受旧 context。池化 runtime 保护独立消费者的连接；composer 用引用保留未发送草稿及正在提交的输入。

验证：Client 全域 329 个文件、4,745 个测试通过；其后针对重入、跨 runtime 引用及真实 apply 的定向 20 项通过。完整构建通过。真实浏览器 Workbench、工作区历史入口与导航验证最初为 10 通过、1 失败、1 条录制专用分支跳过；失败定位为 ZIP 测试仍断言 `session.v4`，实际产物为已实施的 V5。修正版本断言后，Session Header 与 `/export` 双入口、实际 ZIP 内容和观察者隔离的定向重跑通过；未重录 golden。

局部证据不能关闭整个 7A：异步导航代次、Host 转发事件的调用期引用、统一右侧栏的引用所有者以及最终候选验收仍须完成。此处不修改累计源码审查和发布就绪状态。临时测试日志位于 `/tmp/coharness-alpha2-reference-*.log`，不是可跨提交复用的发布凭据。

## 7A：异步导航增量（2026-09-23）

`beginNavigation()` 为初始选择、工作区打开／新建、fork 和跨 runtime Workbench 加载建立同一导航代次。显式选择、清空、切换布局／展示模式、目标切换、明确访问拒绝以及发起插件卸载均能使旧结果失效。请求完成后仍保留 Host 已创建的会话，但不再抢占新视图或丢弃其草稿。四窗格的焦点与布局操作使用同一判定，未创建第二个 ConversationRoot。

定向单元验证 6 个文件、85 项通过，Client 类型检查与完整构建通过。真实 Web 的现有 Workbench、桌面／窄屏历史入口与夹具清单 4 项通过；新增迟到响应场景在真实 HTTP 路径持有创建请求，再执行新的历史选择，验证草稿、选中视图及既有 a11y 输出。首次失败是有草稿状态与空草稿 golden 比较不符；修正用例先断言草稿保留，再由真实输入清空以回放既有输出，定向重跑通过。没有重录 golden 或放宽归一化。日志位于 `/tmp/coharness-alpha2-navigation-*.log`。

仍未关闭 Host 转发事件的调用期引用、辅助栏完整迁移、直接打开时的加载失败呈现及最终候选验收。运行时覆盖率沿用既有基线排除，新增导航文件的定向覆盖率输出为未测量，不据此声称 100%。

后续导航加载交接采用 `commitSessionNavigation`，不修改上游引用 `ready` 的尝试结束语义。工作区历史、新建与初始选择、Workspace 选择和跨 runtime Workbench 接入成功后切换；错误／取消释放临时引用，真实视图成功接管前不拆目标代次。相关 11 个文件、215 项单元测试通过；实际 Web 的 Workbench、桌面／窄屏历史、迟到创建响应、历史网络失败保留草稿及重试共 6 项通过。公开历史加载失败呈现已覆盖侧栏选择；其他直接导航入口仍在累计核对中。

## 7A：辅助栏、独立详情与会话反馈增量（2026-09-23）

Workbench 保持唯一主布局，辅助栏采用上游 dockkit 与标签生命周期。浏览器身份经过确认后，持久化按 principal／runtime／Session 隔离；同名标签在身份切换后重新建立组件生命期。Browser 使用上游 iframe、未知地址、临时 sandbox 与访客 loopback 语义。Markdown 文件链接保留行号，并交由既有工作区资源服务读取；受管 Gateway 不回退到本机打开。

工具详情通过明确 Session／call 地址读取所属完整回合，不依赖聊天窗口仍持有该调用。Host 沿用 Session 与子会话归属授权，冷读不创建 Agent；传输不截去目标调用。隐藏标签不启动详情读取，销毁、换调用或身份变化取消旧请求。真实 Web 验证冷读、分页后打开、刷新后聊天窗口未包含旧调用但详情仍可读，以及没有新增模型回合。

裸 `/feedback` 采用上游分类与备注弹窗；带参数命令和可编辑单消息 sidecar 保持原语义。每个 Session 代次持有独立控制器，销毁后丢弃草稿与读取缓存，迟到成功不能恢复旧弹窗。提交失败保留草稿，重试经过真实 Remote 写入 `feedback/record`；日志共享取决于管理策略，评分不构成共享授权。

证据：全 Client JSON 报告覆盖 367 个文件、5,303 项测试，全部通过；随后反馈生命期增量 6 个文件、117 项通过。完整构建通过。最后一组只读 Web 回放覆盖工具详情、会话反馈及文本反馈命令，3 个文件、7 项通过；原单消息反馈另有通过记录。反馈命令 golden 收窄到其确认行，精确保留 Session 标识与共享策略；公共界面由独立组装场景承接。日志与 JSON 位于 `/tmp/coharness-alpha2-*-feedback*`、`/tmp/coharness-alpha2-ui-integrated-client.json` 及相关 tool-details 日志。它们描述本地未提交检查点，不充当最终发布凭据。

文档首轮检查为 34 通过、6 失败，定位到生成目录陈旧、遗漏的 API 参数说明与 README 格式，继续修复并复核。`ui-dockkit/src` 与固定上游目录逐文件一致；主权门禁比较已提交 HEAD，故在新包尚未提交时仍报告该 tracked 项缺失。保留正确分类，等待统一提交后重新核验，不为本地绿灯改写处分。交付物 Review、远端执行、部署及其环境验收仍未关闭。

## D7：交付物与历史 Review 增量（2026-09-23）

`tool-present` 和 `workspace-changes` 接入实际 base／Web 组装；`deliverables/presented` 与 `workspace/changes` 是当前 Session 格式的必读事件，两个 SDK 保留原始事件。Review 通过明确 Session／事件／文件索引读取回合快照；普通预览读取当前文件。RPC 在读取前后核验 Session、项目目录和文件权限，冷读不创建 Agent，不向浏览器输出快照内部路径。资源由保留的 Session 和对应 runtime 连接持有，释放时清空私有缓存；桌面动作同时核验连接能力与工作区。

证据：交付物 UI 8 个文件、95 项测试通过，定向语句／分支／函数／行覆盖率均为 100%；新增历史读取模块经 85 项 API／传输测试验证，四项覆盖率均为 100%。完整构建通过；真实 Web 只读回放 6 个文件、11 项通过，场景调用真实 present 工具并在回合结束后再次修改文件，独立验证历史 diff 与当前预览。Python 客户端 29 项与 Session 不可变代次 22 项另有通过记录。日志位于 `/tmp/coharness-alpha2-review-*`，对应未提交工作树，不是最终发布凭据。

当前 recorder 保留上游的本机文件与临时目录实现，远端快照还需执行目标适配；Host 重启后的历史内容保留也未实现。不得据此关闭远端 D7 或累计升级验收。


## Office、远端 Review 与桌面授权增量（2026-09-23）

Office/PDF 沿用上游转换及渲染方案，文件读取通过已有 ApiProxy 权限与资源服务。原生 macOS arm64 和 Linux arm64 WASM 的 doc/docx/xls/xlsx/ppt/pptx 转换已实跑，独立核验 PDF 文字；macOS 浏览器还验证页面像素与无效文件拒绝。Linux 镜像补齐字体后通过，保留第一次缺字体失败。Provider 与技能 71 项、客户端 188 项定向测试通过，各自测量源码四项覆盖率 100%。当前 Web 只读回放 Office、Review 和实际组装共 12 项通过，完整构建通过；后台 Office 配置及最终发行环境证据仍待收口。

远端 Review 已通过统一 FS/subprocess 提供方在目标机器执行 Git，临时索引与对象不污染目标仓库；文件工具捕获经版本化、有界 FS 窗口传回 Host。该增量取代上一节的“远端 recorder 尚未适配”状态。51 项定向测试及四项覆盖率 100%，真实 SSH 场景 1 项通过，核验历史内容不随后续编辑变化、仓库索引不变及清理完成。Host 重启后的历史内容保留仍沿用上游临时生命周期；远端断连清理失败不能计作成功。SSH 全部产品资格、连接共享与设置流程仍未关闭。

桌面 native／MCP 驱动接入部署授权回调，缺政策的受管环境不能借用本机权限。161 项定向测试、四项源码覆盖率 100% 与包级编译通过；真实 stdio 子进程验证拒绝不发送指令、撤权传输取消。Gateway 迁移 032 增加版本化用户／项目资格，真实 PostgreSQL 执行身份测试 21 项、管理 HTTP 测试 31 项、管理 UI 与 API 测试 13 项通过。用户资格、项目授权、只读限制、并发版本冲突和通知通道均有拒绝验证。桌面会话确认、租约到实际驱动的完整提供方和三平台 GUI 验收仍未完成，不能据资格编辑页面宣称功能可用。

上述证据来自当前未提交工作树，日志分别为 `/tmp/coharness-alpha2-office-*`、`/tmp/coharness-alpha2-remote-review-*` 与 `/tmp/coharness-alpha2-desktop-*`，不能替代最终候选 CI 或发布证明。未提交、推送或创建 PR；累计升级状态保持未完成。

Desktop confirmation and lease binding: PostgreSQL migration 033 stores authenticated per-user consent for the exact Session, node, runtime generation and desktop, with qualification revision invalidation. Real PostgreSQL execution plus private HTTP tests passed 73 cases; the coordinator and private API tests passed 66 cases after adding Session-bound grant keys. Source and built CLI desktop transcripts each passed two read-only replays; optional fixture plugins are installed in the temporary Profile. These results do not prove the pending complete Gateway driver policy, user-facing confirmation workflow or three-platform GUI acceptance.

## 桌面根会话确认与工作流租约接线（2026-09-23）

当前增量已补齐 Gateway 执行提供者到实际驱动政策的接线，以及 Web 输入区的个人确认／撤回流程。确认由活动根 Agent 所有权继承，历史 fork 不借用父会话确认；每个实际参与者仍分别核验。受管根工作流跨调用持有同一租约，串行化驱动操作，执行和返回前复核资格、确认及租约；不确定的驱动取消保持 stopping，不能自动宣称操作系统输入已排空。

真实 PostgreSQL／HTTP 的执行身份测试 27 项通过，覆盖当前用户确认查询、节点变化、撤权再授权及拒绝伪造身份。31 项定向测试通过，测量的工作流政策和确认组件源码四项覆盖率均为 100%。实际构建 Web 的 2 项新场景完成局部快照生成及只读回放，证明空白会话入口、保存失败后重查、确认和撤回均走真实 ApiProxy；该场景使用确定性 Gateway 传输，不冒称完整真实 Gateway／桌面 GUI 验收。构建、日志和覆盖率绑定当前未提交检查点；三平台 GUI、节点部署设置及最终候选验收仍未关闭。

## Gateway SSH／Webhook 面、PTC 检查器与三处缺陷修复增量（2026-09-24，未提交候选）

本批在 `codex/alpha2-complete-alignment` 工作树实现，尚未提交、推送或开放发布。本增量取代上文的"SSH 全部产品资格、连接共享与设置流程仍未关闭"（远端 Review 段）、"本地补强剩管理员开关、重放防护、限流与 Session 归属策略（7B）"（源码级事实段）及"本批不关闭 …SSH…Webhook…"（7A 启动段）三处待办陈述的相应部分。

**三处审查缺陷修复。** Session 版本准入补齐 3／4 代；权限目录改为单一缓存并修复旧响应失效竞态；`tool-terminal` 的 `presentResult` 只在本次发送实际等到会话退出时才携带退出码或信号，仍在运行的会话不再被呈现为成功退出（`sendExitStatus` 收窄 `tool/result` 元数据，缺失或畸形元数据按未知处理）。

**SSH Gateway 面（新增，CoHarness 自有设计）。** PostgreSQL 迁移 038 建立 SSH 目标登记、按用户资格策略与项目共享三张表，资格与共享变更接入既有访问失效外发。`PostgresSshTargetService` 提供管理员 CRUD、按目标列出与共享管理；共享要求项目所有者身份，每个用户仍需独立资格。`/internal/runtime/ssh/resolve` 端点由签名执行主体驱动 `authorizeSsh` 资格校验后下发连接配置；`context/gateway-execution` 新增 `GatewaySshAuthorization` 服务作为唯一放行通道，`ssh/ssh` 包声明授权契约。Admin API 与 `gateway/admin-ui` 的 SSH 页提供目标编辑、共享与资格管理。真实 PostgreSQL 集成测试 4 项通过（CRUD、共享权限矩阵、resolve 授权拒绝）。Gateway 全部既有 PostgreSQL 测试组复核通过。

**Webhook Gateway 面（新增，CoHarness 自有设计）。** PostgreSQL 迁移 039 建立管理员管理的 Webhook 端点表：结构化 Provider 规则与提示词模板（无任意 JavaScript）、执行账号、目标运行时、受理限值、防重放窗口及只写 AES-256-GCM 签名密钥（复用组织凭据密钥文件，新增 `HGW_WEBHOOK_SECRET_KEY_FILE` 配置），并向投递回执表追加保留的已验证事件载荷供管理员重跑。`webhook-intake.ts` 编排公共 Provider 路由：签名校验先于 CSRF 检查（Provider 签名即认证），严格请求校验、内容去重与限流经投递账本实现，重放别名绑定每个已见投递 ID。派发经 `webhook-dispatch` 用途断言调用 runtime 回环端点 `/api/internal/gateway/webhook-dispatch`，该端点强制 POST、当前 principal 用途与未过期校验、有界请求体，并经 `createWebhookSession` 完成会话创建归属与执行授权；runtime→gateway 方向在 `/internal/runtime/*` 拒绝 webhook-dispatch 用途断言，双向用途隔离。管理员重跑走审计路径且不复用自动投递 ID。Admin API／UI 暴露端点管理与投递诊断（不含载荷与密钥），端点默认禁用、需管理员显式开启。真实 PostgreSQL 集成测试 4 项通过（签名校验、无效 JSON、去重、过滤与限流），runtime 派发路由测试 9 项通过（缺失主体、错误方法、过期主体、错误用途、校验失败、派发失败映射）。

**PTC 轨迹检查器移植。** `code-program.ts`／`copy-codes.ts` 自上游原样移植，`TrajectoryTable` 新增 Code/Result 面板：`run_code` 按确切工具名识别，源代码从已记录工具参数解析，语言由已记录 schema 描述推断（不从源码猜测），输入面板支持原始 JSON 切换与复制，输出面板经本地 JsonTree 渲染 JSON、否则按纯文本/错误呈现。保留本地虚拟化桌面表格、移动端 feed、本地化字典与既有 JsonTree 架构；上游 `string-wrapping-store.ts` 对应可展开 JSON 字符串换行偏好，本地 JsonTree 无可展开字符串组件故不携带，`upstream-sync.json` 的 `removedUpstreamPaths` 维持该条目。压缩中断标记 `COMPACTION_INTERRUPTED_ERROR` 随检查器一并落地。`ui-primitives` 的 `CodeBlock` 增补 `contentRef`/`lineNumbers`/`showHeader` 与 `.content`/`.numbered` 样式，保留本地 token 命名与移动端规则。轨迹表测试 30 项、ui-primitives 相关测试与 DOM parity 快照复核通过。

**台账与门禁。** `scripts/upstream-sync.json` 复核：`ssh/fs-ssh`、`ssh/ssh`、`webhook/webhook` 维持 `adapted`（能力包携带本地增量），`context/gateway-execution` 维持 `owned`（SSH 授权与 Webhook 派发属 CoHarness 自有面），`api/terminal-controller` 等新包已登记。本轮 lint 合规改造把 `boot/hmr`、`ptc-runtime/ptc-runtime-node`、`subprocess/subprocess-local`、`terminal/terminal`、`terminal/terminal-bash` 的 `withResolvers<void>` 统一为仓库约定的 `withResolvers<undefined>`，连同 `tool-terminal` 的 `presentResult` 行为修复一并重分类为 `adapted`；`verify-upstream-sovereignty` 现 78 tracked／189 adapted／29 owned／2 replaced／22 upstreamOnly 全绿。`verify-client-packages` 修复 `api/terminal-controller`、`client/ui-sidebar-terminal`、`client/ui-renderer` 三个 manifest 的 peer/dev 分类后全绿。全仓 lint（3,908 文件）0 警告 0 错误，全仓 typecheck 通过，Admin UI 生产构建通过，`gateway-execution` 全部 149 项测试通过。`gateway/deploy/postgres/README*` 双语补齐迁移 032–039 条目。

**仍未关闭。** 外部持续 Team 持久化与重启恢复、部署迁移协调（单写者切换、备份恢复演练、滚动重启顺序）、平台验收（真实 DeepSeek 流程、三平台桌面/native、五平台 Python、LAN/公网双用户、Linux/macOS PostgreSQL 部署）、2,641 个变化文件的逐文件语义审查与累计对账、前后性能对比证据，以及绑定最终候选的发布证据均未完成；本批局部绿灯不得据以宣称发布就绪。管理 UI 与轨迹检查器属用户可见 GUI 变更，打包 PR 前需按仓库规范补真实服务端/模型流程的 GIF 证据。

## Session 双迁移准入收敛与 legacy 目录移除（2026-09-24，未提交候选）

本批在 `codex/alpha2-complete-alignment` 工作树实现，尚未提交、推送或开放发布。收敛"两套迁移准入"这一审计遗留分歧：此前 JSONL 读侧走上游严格生成目录，而 SQLite/PostgreSQL/Gateway 逻辑读侧走本地 `dsh-session-format` 的 legacy 批量目录（`catalog-default.ts`/`legacy-*`），同一历史输入在两条路径上准入结论不同。

**单一规则来源。** `dsh-session-format-catalog` 新增 `sessionLogicalFormatCatalog` 作为逻辑（已解码）存储的唯一入口：逻辑头投影（`seedLength`→`isSeeded`、`delegationDepth` 缺省补 0、拒绝未知键与矛盾种子元数据）→ 逐版本 admission（v3 行跑 `assertV3EventAdmission`、v4/v5 行跑 `assertV4EventAdmission`，与物理 codec 的 decoded 检查一致）→ 共享严格链（v0→v1、v1→v2、v3→v4、v4→v5 直接复用上游 stage）→ `finish` 经 `restoreReleasedV5Artifact`＋`validateInstalledCurrentSessionArtifact` 做当前工件校验。v2 边由新 `coharnessV2ToV3Dialect` 承担：先归一已发布的 CoHarness v2 数据库方言（`compact/*`→`compaction/*` 重命名与 bracket 归属、裸 `end-seed` 标记、steering 消息、扁平消息载体与确定性 legacy ID、`request/header` 系统提示提升为 system head、重试链归属、非 surface 封套元数据剥离与引用重映射），再复用严格 stage 的 `assertEvent`/`remapEvent`/`renamePtcEvent`/`canonicalizeTransformedEvent` 原语。物理路径拒绝的畸形探针（如 `{ turn: 1, unexpected: 1 }`）在逻辑路径同样被拒。

**移除项。** 删除 `dsh-session-format` 的 `catalog-default.ts`、`legacy-catalog.ts`、`legacy-chain.ts`、`legacy-json.ts`、`legacy-types.ts`、`legacy.ts` 与公开 `/legacy` 子路径及其三套规格；包入口只保留现代模块。消费方重接：PersistenceCoordinator 与 Gateway `runtime-api` 改用 `sessionLogicalFormatCatalog`；`core/session` 的 `validateSessionHeader` 恢复上游语义——Session 构造边界拒绝非当前版本头，迁移职责唯一归 coordinator 存储边界（消除 core/session→format-catalog 的反向依赖与潜在项目引用环）。夹具修复：v0 头配 v2 词汇的不协调夹具改标 `version: 2`，陈旧期望版本 4→5，`assertVersion` 助手放开为 `< currentVersion`。

**验证证据。** `packages/session/` 85 文件 2230 测试全绿（含 session-format-catalog 5 文件 138 测试）；`logical.ts` 与 `coharness-v2-dialect.ts` 在 `vitest --coverage` 下逐文件 100%（语句/分支/函数/行）；`verify-export-jsdoc`、`verify-agent-note-format`（931 条）、`verify-md-links`、`verify-doc-budgets` 全绿；新测试文件与源码经 `run-oxlint` 零告警；`jscpd` 全仓 0.04%（方言文件对 v0→v1 正规化与 v2→v3 生成头簿记的镜像以 `jscpd:ignore` 区域注明移植理由）。删除的 legacy 规格的归一化覆盖已移植进 `tests/logical-dialect.spec.ts`（89 用例），含紧凑词汇、转向消息、扁平载体、重试链、压缩归属、引用重映射、种子边界与各畸形拒绝路径；严格 stage 校验后仍不可达的防御分支按仓库惯例删简或以 `v8 ignore` 附理由标注。

**仍未关闭。** 本批不关闭 L18（CI 平台矩阵/覆盖率车道须对最终候选重跑）与累计逐文件语义审查；Session 迁移的其他后端验收（真实 PostgreSQL 库回归）仍挂 2B/8 台账。

## 工作区文件预览 Markdown/HTML 正文增量（2026-09-25，未提交候选）

本批在 `codex/alpha2-complete-alignment` 工作树实现，尚未提交、推送或开放发布。对应 7C 面中 `ui-sidebar-documentpreview` upstreamOnly 行的承接部分：上游注册的 HTML 与 Markdown 预览正文落到本地 Workbench 文件标签，而非移植上游渲染器注册表。

**同一授权资源服务。** `WorkspaceFileTab` 按扩展名路由到四种正文：Markdown（`md`/`markdown`）复用带版本保护的 `readPreview` 分页累计到 `eof` 后经 `MarkdownText` 不换行渲染；HTML（`html`/`htm`）经新增 `readFileBytes`（`stat`＋锚定首观测版本的 `readBytes` 窗口）读完整源，`packHtml` 打包直接声明的相对 `.js` classic 脚本与 `.css` 样式表（客户端折叠 `.`/`..`/query/fragment 后走同一授权 `stat`+`readBytes`，限值 4 MiB/资源、32 MiB、64 资源；外部/根相对/scheme/反斜杠/NUL 引用不读取；module、CSS `url()`/`@import`、运行时 `fetch` 不支持），产物在仅 `sandbox="allow-scripts"` 的不透明 Blob iframe 中运行，替换/卸载吊销 Blob URL。PDF/Office 与其余文件路径不变。生命周期、ACL、取消沿用 `WorkspaceResourceRegistry`：同一 `WorkspaceResourceOpenRequest`、撤权 `resources.disconnect`、替换/卸载 abort、await 前查信号防迟到发布；无第二 registry、无新 RPC（上游 `readAll`/`readRelated` 由客户端解析＋既有窗口读取承接）。

**验证证据。** 新增 bootstrap 4、pack 9、read-relative 15、markdown 7、html 12、tab 路由 4、真实 apply 组装 2 项 spec；`packages/client/ui-workbench` 239/239 全绿；`apps/web/tests/workspace-files.e2e.ts` 真实浏览器链路验收 Markdown 渲染、打包 iframe `sandbox`/脚本置位、changed/reload 收敛并录 `markdown.expected.md` golden；oxlint 40 文件零告警、仓库 typecheck、verify-export-jsdoc、verify-agent-note-format 937 条、包 bundle 与 apps/web Vite 构建均绿。`upstream-sync.json` 的 `client/ui-sidebar-documentpreview` 补 `replacedBy: client/ui-workbench`；新增笔记 2026-09-25-workbench-html-markdown-previews；就地修正 2026-09-08 note 中未落地机制断言。

**仍未关闭。** 本批属产品可见 GUI 变更，PR 需按规范附真实服务端/模型流程 GIF——与 B6 同一阻塞（无 `.env`/DEEPSEEK_API_KEY、未提交工作树无法归因干净 commit）；上游 code/image/SVG 独立渲染器与 viewer 切换面未携带（本地 `data:` 图片与文本回退承接，代码源查看经文本路径），累计逐文件语义审查与发布证据仍挂台账。

## Webhook 结构化仓库筛选增量（2026-09-25，未提交候选）

本批在 `codex/alpha2-complete-alignment` 工作树实现，尚未提交、推送或开放发布。对应审计 B8：此前端点 schema、Admin UI 与派发只实现 events/actions 筛选，repository 仅能出现在模板里；现把批准的结构化仓库筛选贯通到执行入口。

**筛选贯通。** 迁移 `gateway/deploy/postgres/migrations/042_webhook_repository_filter.sql` 为 `harness.webhook_endpoints` 增加 `repositories text[] NOT NULL DEFAULT '{}'`（基数 ≤ 64），存量端点保持接收全部仓库。注册 zod 校验每条为结构化 `owner/repo` 完整名（`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`），非法条目在 create/update 处即 400。`GatewayWebhookIntake.dispatch()` 在为投递预留运行时工作前评估筛选：已验证载荷的 `repository.full_name` 与配置条目做大小写不敏感精确匹配（贴合 GitHub 命名语义），配置了筛选即失败关闭——字段缺失、畸形或不匹配均不派发。`repositories` 与其他规则走同一 revision 校验更新与 `dispatchConfig` 路径，管理员重跑按当前筛选重新评估。

**诊断与界面。** 筛选未命中统一记 `state: 'ignored'` 并附 `errorCode` 指明未命中规则（`event-unmatched`/`action-unmatched`/`repository-unmatched`）；回执 `error_code` 列与 Admin 投递视图徽标本已渲染该字段，被排除投递现在显示具体规则而非无解释忽略。Admin 端点表单新增逗号分隔 `owner/repo` 编辑框，端点表新增仓库筛选列。`ignored` 回执 shape 扩展为可选 `errorCode`，complete() 的幂等比对不受影响。

**验证证据。** `gateway/tests/webhook.spec.ts` 真实 PostgreSQL 套件 5/5 通过：端点 create/update 的 repositories 往返、非法条目 400、匹配仓库派发、不匹配仓库 `ignored`+`repository-unmatched` 且 runtime 零请求、缺失 repository 字段失败关闭、`ACME/Widget` 大小写变体照常派发；事件筛选既有断言升级为校验 `event-unmatched` 代码。`gateway` 与 `admin-ui` typecheck 干净。

**文档与台账。** `gateway/README*` 双语补端点字段清单中的结构化仓库筛选与 `ignored` 的 reason-code 语义；`gateway/deploy/postgres/README*` 迁移清单补齐至 042（一并补记此前未登记的 040 会话级 SSH 绑定与 041 部署控制面）；新增笔记 2026-09-25-webhook-structured-repository-filter（双语），与 2026-09-23-webhook-execution-identity 交叉链接（筛选发生在签名验证与持久预留之后、受管派发之前，投递身份与执行账号契约不变）。`upstream-sync.json` 无需变更：本次改动面（`gateway/` 部署件与 Admin UI）在包追踪之外，`webhook/webhook` 维持 `adapted`、`context/gateway-execution` 维持 `owned`。

**仍未关闭。** 跨节点部署形态下经真实 Provider（GitHub App/Webhook 配置）的端到端验收、Admin UI 生产构建回归与发布证据仍挂台账；本批局部绿灯不得据以宣称发布就绪。

## Python SDK 运行时 Windows x64 目标增量（2026-09-25，未提交候选）

本批在 `codex/alpha2-complete-alignment` 工作树实现，尚未提交、推送或开放发布。对应审计 B9：上游 alpha.2 的 `build-exe-for-python-sdk` 可复用构建器与发布管线已含 `node24-win-x64`，本地清单与构建脚本虽早已建模 `win` 平台，但无任何工作流构建该目标，且运行时、组合与冒烟面残留多处 POSIX 假设；本批把 Windows x64 补齐为一等运行时目标。

**运行时与组合。** `tool-fs-search` 的 `resolveRgPath` 移植上游 Windows 伴随文件命名：win32 下由 `process.execPath` 解析出的主干名推导 `<stem>-rg.exe`，其余平台保留 `<execPath>-rg`；上游同函数内的 Electron `.asar.unpacked` 分支未携带——本地无 Electron 宿主（`apps/desktop` 未移植），按「要求当前 owner」原则记为有意差异，随桌面宿主引入时补；新增 `rg-sidecar.spec.ts`（4 用例：POSIX/win32 伴随命名、普通 Node 依赖回退、无 sidecar 回退），上游同文件的 Electron ASAR 用例随之未携带。`examples/jsonrpc-agent/minimal.cordis.yml` 用 `disabled: !!js` 条件按平台选择持久 shell 方言（win32 挂 `dsh-tool-pwsh-persistent`＋`pwsh` 方言终端后端，其余平台挂 `dsh-tool-bash-persistent`），`python/sdk-runtime/package.json` 补齐 PowerShell/终端组合所需依赖使闭包在新组合下闭合（4 preset＋151 包）。`smoke-python-runtime.py` 按 `sys.platform` 选择 `pwsh`/`bash` 工具名、PowerShell/bash 命令体与 `tempfile.gettempdir()`/`/tmp` 期望；极简模型可见快照新增 `minimal/win-x64/model-visible.json` 变体（工具名、描述与命令参数文本随方言不同，上游同款布局），advanced 快照保持单份。

**CI 与发布。** PR 必需 `python-runtime` 作业目标由 `node24-linux-x64` 扩为 `node24-linux-x64,node24-win-x64`（沿用上游 PR 策略，Windows 步骤原生 `pwsh`），`python-release.yml` 发布验证保留全部五目标并在精确文件名校验中补 `win_amd64` wheel；`ci-workflow.spec.ts` 同步锁定期望并新增 Windows 目标回归断言。上游 `ci-master.yml` 的 master-push 平台腿（linux-arm64＋两个 macOS）未携带——本地私有发布路径由 `.gitlab-ci.yml` 在 tag 上构建 linux-x64/arm64/macos-arm64 wheel，属有意部署差异，记此登记。

**验证证据。** `verify-runtime-closure` 151 包闭合；`ci-workflow.spec.ts` 18/18；`tool-fs-search` 全套 153/153（含新增 rg-sidecar 4）；本机 macOS arm64 构建（exe≈200MB＋`-rg`＋spawn-helper）后 `smoke-python-runtime.py --scenario all` 全场景通过并重录 POSIX 快照（advanced 快照随 inspect 工具面重录：`cordis_inspect_list/query`＋本地扩展 `cordis_inspect_self`，retired `cordis_define/run/stop/undefine` 集合有显式拒绝守卫）；win-x64 快照按同一变换规则生成（`{{tool-result}}` 掩码与上游一致）；`verify-cordis-config` 181 文件、oxlint 目标文件零告警、仓库 typecheck、md-links 3007 文件、doc-budgets、note 格式/分类 939 条、translation-pairing 1499 对全绿。文档双语同步：`python/development*`、`python/sdk-runtime/README*`、`examples/jsonrpc-agent/README*`、`docs/user/guide/python-sdk*` 的平台清单、目标列表、sidecar 命名与 POSIX-only 表述全部改写为五平台现状；就地改写 2026-08-12（PR 必需 CI 两目标）与 2026-08-13（win-x64 快照变体）两条 note 的过时机制断言，新增 2026-09-25-windows-x64-python-runtime。

**仍未关闭。** 原生 Windows 构建与冒烟归 CI 所有（本机未执行 Windows runner），win-x64 快照以确定性变换生成、由 Windows 腿实跑比对兜底；上游 profiles 体系的 advanced 场景代际（profile patch 预注册 `snapshot_double`、auto-review 拒绝链）未携带，本地场景围绕 inspect 面重设计属有意差异；上游 `ci-master.yml` 缺失按上段登记；#2488 运行时上下文快照平台差异不变；L18 平台矩阵与最终候选发布证据仍挂台账。

## 托管桌面驱动启动组合增量（2026-09-25，未提交候选）

本批在 `codex/alpha2-complete-alignment` 工作树实现，尚未提交、推送或开放发布。对应审计 B10：此前发货的 base/web/governance 补丁不注册 computer-use 驱动，治理补丁也不给 `gateway-execution` 配置 `desktop`——Admin 授权与托管策略齐备，但启动的运行时从不携带驱动，托管桌面路径无法执行真实调用。本批把驱动准入做成节点配置控制的启动组合，而非可选用户 bundle。

**节点声明式启用。** `HGW_DESKTOP_ID` 声明节点本地桌面标识（去空白后 1–256 字符、不含控制字符，镜像运行时 `desktop` schema 上界），缺省即完全关闭：不物化、不写补丁行、不读驱动包。设置后 `mountPolicyBundles` 把驱动包物化进运行时 profile 并向组合补丁追加三行：`gateway-execution` 的 `config.desktop`（由该提供者发布托管策略）以及 `dsh-computer-use` 与 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` 两条 insert。`dsh-computer-use` 经安装模块回退解析（`gateway-execution` 的 peer），仅驱动包需物化；补丁只发一行驱动，保持 computer-use 服务的单提供者不变量。

**物化与覆盖。** 驱动物化与治理/目录守卫包走同一原子暂存机制（`materializePolicyPackage`）：只复制 `package.json`、`lib/`、`cordis.patch.yml`，`cpSync` 解引用、不符号链接源码检出，staging＋rename 原子就位。`HGW_DESKTOP_DRIVER_PACKAGE` 指向绝对包目录；发布模式下默认钉在 `HGW_RELEASE_ROOT/packages/experimental/computer-use-cua-driver-mcp`，显式覆盖必须解析到同一发布路径内；包缺失或不完整在挂载处大声失败。`HGW_DESKTOP_DRIVER_COMMAND`/`HGW_DESKTOP_DRIVER_ARGS` 以字面量命令与 JSON 参数列表覆盖提供者的 `cua-driver` 可执行文件查找与 `mcp` 参数向量，不经 shell。

**范围边界。** browser-use 保持显式本地组合——它无托管授权缝，挂载进受管运行时会脱离策略运行；`OPTIONAL_BUNDLES` 通道未用于本路径（可选 bundle 是用户为个人 profile 选择的 CLI 层，托管桌面是管理员控制面）；实验驱动包不进默认产品组合与默认模板；个人与项目运行时在同一节点下共享同一启用面，运行时策略仍按当前资格与活动根确认逐次拦截。

**验证证据。** `gateway/tests/config.spec.ts` 20/20（缺省、`HGW_DESKTOP_ID` 校验、驱动包默认/覆盖、命令覆盖、JSON 参数解析、发布根钉定与越界拒绝）；`gateway/tests/instances.spec.ts` 22/22（新增：启用全量覆盖——物化产物、patch 三行、`config.desktop`、驱动 config 覆盖；裸 seat 无进程覆盖行；驱动包缺失失败；既有用例确认缺省无驱动行）；gateway typecheck 干净。

**文档与台账。** 双语同步：`gateway/README*` 桌面段补启动组合事实；`gateway/deploy/README*` 新增托管桌面供应段（驱动包供应、`HGW_DESKTOP_*` 清单、资格/确认链）；`packages/context/gateway-execution/README*` 记录 `desktop` 配置来源；`docs/subsystems/computer-use*` 记录受管挂载条件。新增笔记 2026-09-25-managed-desktop-launch-composition（双语），与 2026-09-23-managed-desktop-execution（策略面）及 2026-09-12-computer-use-provider-registration（注册契约）交叉链接。`upstream-sync.json` 无需变更：`gateway/` 部署件在包追踪之外，`experimental/computer-use-cua-driver-mcp` 维持既有登记。

**仍未关闭。** 真实桌面宿主的端到端验收（Cua Driver 实跑＋OS 桌面权限授予＋资格/确认/租约全链）属跨节点部署证据，仍挂台账；本批局部绿灯不得据以宣称发布就绪。

## 门禁遗留修复增量（2026-09-25，未提交候选，B10 验证暴露）

B10 验证中运行 `verify-default-product-isolation`、`verify-package-dependencies`、`knip` 发现四处此前批次的门禁红灯并就地修复：

**外部 kit 包豁免丢失。** `verify-default-product-isolation.ts` 漏带上游 `EXTERNAL_KIT_PACKAGES` 豁免——`@deepseek-ai/libreoffice-kit` 是独立发布的平台引擎入口包（pnpm-workspace catalog 声明 wasm＋四平台变体，lockfile 已按外部包安装），并非工作区包。按上游逐字补回豁免常量与 `reference()` 分支；上游同文件仅另有 `PRESET_PATTERN` 路径差异（本地 preset 布局不同，有意保留）。

**休眠实验依赖。** `apps/cli` 的 `dependencies` 残留 `@deepseek-ai/dsh-experimental-agent-team-web-profile`——该包已按 FIXME 移出 `OPTIONAL_BUNDLES`（待 `api/session-controller` 与 `client/ui-session` 随 Web session 栈落地），实验包不可留在默认产品依赖内（隔离门禁即为此设，`packages/experimental/AGENTS.md` 明禁）。移除该依赖并把 FIXME 扩为「恢复 OPTIONAL_BUNDLES 条目与 apps/cli 运行时依赖」；`agent-team-web-profile` 包本体保留在工作区，families/规格清单不受影响。

**依赖策略漂移。** `package-dependency-policy.ts` 三项：补上游已评审的 `dsh-deque#Deque` SAFE 分类（上游 terminal-controller 同款 import；同步把本地 spec 的 `toBeUndefined` 快照断言改为上游同款 `toEqual(['Deque'])`——SAFE 清单的人工评审 tripwire 由 spec 显式断言承担，本次为同步上游既有评审结论而非新增例外）；删本地多出的 `dsh-session-format-catalog` peer-required 行（policy scope 只覆盖 Client 面与 configured-host 包，`session-persistence-jsonl` 等纯 host 消费方不在扫描集内，条目判 unused，上游本无此行）；补 `dsh-subprocess#SubprocessExecutableNotFoundError`（上游 PEER 行，本地 terminal-controller 同款 import 漏分类）与 `dsh-client-connection#createRpcStreamHttpHandler/RPC_STREAM_PATH`（CoHarness 自有的 gateway HTTP 传输导出，按 peer-required 归类强制单实例解析）。

**清单与 knip 配置。** `ssh/ssh` 的 `dsh-credentials` 由 dependencies 改 peerDependencies（共享服务包惯例，dev 保留）并补 `dsh-typert-protocol` peer＋dev（`declare module` 合并惯例，同 llm/collaboration）；`session-format` 删除无引用的 `dsh-llm` 依赖；`knip.json` 为 `agent-team-web-profile` 补 resolver-manifest 豁免（`cordis.patch.yml` 声明的 `client-ui-agent-team`，同 `agent-team-profile` 惯例）并为 `ui-settings-unarchive-sessions` 补 `.tsx` entry/project 模式（包测试全为 tsx，通配 `packages/*/*` 的 `.ts` 模式无匹配）。

**验证证据。** `verify-default-product-isolation` 283 包/1661 runtime sources/160 Web plugins 排除实验包；`verify-package-dependencies` 61 包符合策略；`knip` 零 findings 零 hints；相关 spec 112/112（verify-package-dependencies＋verify-default-product-isolation）；`app-boot` 82/82（OPTIONAL_BUNDLES↔cli deps 一致性）；ssh 153/153、session-format 54/54；pnpm-lock 同步；改动文件 oxlint 零告警。

## read_image 画廊渲染增量（2026-09-25，未提交候选，B11）

本批在 `codex/alpha2-complete-alignment` 工作树实现，尚未提交、推送或开放发布。对应审计累计审查发现的真实功能缺口：本地 `read_image` 后端、附件存储与授权加载链路齐备，但 Web 工具 UI 没有图片卡片材料与 keyed `read_image` 行——结果只能走 generic 文本渲染，丢失上游 alpha.2 的画廊呈现。

**卡片材料与行。** 移植上游 `image-card-model.ts`：仅受理落定、非错误的 `read_image` 调用；校验 `file_path`、持久化 meta（根调用必须有有效 `{path}`，嵌套调用回退自身参数路径）、内容仅含受支持 text/image 块；从结果内容提取持久图片引用并单独抽出文本信封，杜绝原始附件对象被 JSON.stringify 打到图片下方；标签经工作区相对化与 home 缩写。新增共享 `read-family-row.tsx` 组装（浏览图标、标题、摘要、输出/错误、路径处理），`read-row.tsx` 改写复用；keyed `read-image-row.tsx` 注册 `read_image`，模型为 null 时回落 generic 渲染，不吞内容。

**渲染通道的本地适配。** 上游的 `tool.call.images` 子槽未移植：本地 chat 节点本就把 `renderMessageImages` owner prop（背后是 `conversation.message.images` 单槽）递给工具树，`ToolCallOwnerProps`/`ToolCallTree` 只需把渲染器与 `nested` 旗标沿 root/嵌套递归下传；details 面板槽名全局唯一约束下新增 `conversation.details.images` 姐妹槽位，`ui-attachment` 用同一 `MessageImages` 组件注册两处——槽位授权规则（children 声明才可 renderSlot）一处不违。`loadImage` 始终来自 session/conversation 层，ui-tool 不推导 URL、不绕授权。

**附带移植。** `readCallLine`/`filePathLine`——read 卡片按调用自身 offset 携带 `{line}` 打开文件；`fs/tool-fs` `read_image` 的 `presentationMeta` 路径投影（初版误置 output 外层被 typecheck 拦下，已按上游校正进 output 内，并证实 `result.meta` 端到端写入）。

**验证证据。** `image-card.client.spec.tsx` 23/23（模型各分支、画廊经 renderMessageImages、文本信封不打印附件 JSON、空画廊可读、无渲染器降级、running/error/nested/键注册）；`read-card.client.spec.tsx` 30/30（含 `readCallLine` 与 `{line:41}` 打开断言）；`tool-detail-read.client.spec.tsx` 4/4（新增：details 经 `conversation.details.images` 转发 session loader）；`apply-inject` 16/16（`DetailsInjected.loadImage`）；`ui-attachment` spec 33/33（双槽注册/卸载）；`tool-fs` 349/349（新增 meta 投影与 live `result.meta` 断言）。四包 oxlint 零告警、typecheck 干净、`verify-package-dependencies` 0 violation（`dsh-attachment` 按共享附件引用归类 peer+dev）、`gen-client-catalog` 已重生成、`verify-client-catalog` 通过。

**仍未关闭。** 浏览器真实链路 GIF 验收按仓库 GUI 政策属 PR 随附义务；本批局部绿灯不得据以宣称发布就绪。

## 性能基准套件移植与 CI 门禁（2026-09-25，未提交候选）

本批在 `codex/alpha2-complete-alignment` 工作树实现，尚未提交、推送或开放发布。上游 `benchmarks/` 六个场景目录此前全部缺失，对应 `node 24 / benchmarks` 必需 CI job 及其 spec 钉住、五个支撑 Agent Note 三件套与 `request-freeze.spec.ts` 均未携带。本批将其完整落地，全部测量为真实运行数据。

**移植面。** `session-open`（17 用例：released-v0 合成日志迁移、四阶段剖面、首屏历史、冷 Agent resume、128 MB 受限堆）、`agent-continuation`（请求历史/工具续跑/子体目录/sdk-minimal profile 全路径）、`terminal-io`（4 用例）、`long-session-browser`（真实 Chromium 经 shipped-composition Web scaffold）、`conversation-fold`、`active-stream-reconnect` 与 `synthetic-history` 夹具校验。

**本地适配（四处，均为架构差异而非语义放宽）。** `session-history-adapter.ts`：上游 `api/session-controller` 未携带，以本地 `SessionQueryEngine`/`observeSession` 加 `host/apiproxy` 的 model-selection 投影重建同款跟随语义（promote 仍在首帧 yield 后的下一次拉动发生）。`conversation-fold/runtime-client-shim.ts`：`dsh-client-runtime/client` 是浏览器模块表工厂无法在 plain-Node 解析，tsdown alias＋neverBundle 收窄把所需叶模块内联进 worker，其余包导入仍走 lib 出口。`agent-continuation` 改用本地 SDK 嵌套 launch 形态（`command/args/cwd/env`＋`--patch`）驱动 sdk-minimal profile。`long-session-browser` 适配本地 scaffold（`baseUrl` 字段、`<textarea>` composer、可重渲染的 Load earlier 交互）。

**conversation-fold 缩放比重校准（有依据的本地分化）。** 上游期望 2.5×/上限 3.125× 假定 fold 成本与记录数成比例；本地 fold 每次窗口替换还重建 location、turn-navigation 与 timeline 投影，小窗口固定成本抬高比值。实测缩放稳定 4.6–5.3，期望改为 5×/上限 6.25×——判别力保留（逐 delta 重放退化约 11× 仍被拒）。同一笔额外汇编也使绝对时间期望重校准为 18 ms（上限 45 ms）：首个托管 Ubuntu 运行实测 41.7 ms，超出按上游较轻 fold 校准的 40 ms 上限、但在按本地参考机的 2.5 倍系数预算内。依据写入 `session-open-performance-gate` note 双语。

**long-session-browser Trajectory 上限重校准（同型边界修正）。** 上游 520 ms 目标/650 ms 上限处于实测托管分布内部：上游自己的 run 35095609422 已记录 666.7/630.8 ms 中位数（旧上限拒绝其首次执行），本分支 run 36208631023/36215749263 的中位数为 629.5/658.4 ms、逐样本 596.9–664.7 ms。目标改为 680 ms（上限 850 ms），对最大实测中位数向上取整，记录样本对照同步覆盖新区间；其他终点预算不变。依据写入 `frontend-performance-budgets` note 双语。

**CI 门禁补齐（真实缺口）。** `ci.yml` 新增 `node-24-bench` job：标准托管 `ubuntu-24.04`、不经 failover 路由、无 `needs`（独立测量车道）、15 分钟超时、pnpm store 无条件恢复、Chromium 安装与 `DSH_GATE_VERBOSE=1` 的 `check:ci:bench`；`all-checks-passed` 收编该 job。`ci-workflow.spec.ts` 移植上游三组断言（failover 无关性、cache 形态、步骤与超时钉住），21/21 通过。

**附带发现的真实缺口（已修复）。** `request-freeze.spec.ts`（WeakSet 冻结证明的专属 spec）未随优化一同移植——已按本地语义适配补入：`dsh-llm` 携带自有 `deepFreeze`（避免 client bundle 依赖 host-only util 包，spy 目标随之改到 `dsh-llm` 再导出面），且本地 `fromRestore` 在收养时即深冻结恢复图（`freezeRestoredObject`），"包装器可变"断言按本地更强冻结语义反转，5/5 通过。上游五个支撑 note 三件套补齐：`session-open-performance-gate`（fold 校准行按本地化）、`frontend-performance-budgets`、`standard-hosted-benchmark-runner`、`backend-continuation-performance`、`agent-request-freeze-evidence`，及被其引用的 `minimal-profiles-persistent-shell-only`（对未采纳的 base-editor 决策的交叉引用按本地事实改写）。六个配对全部经 `verify-translation-pairing` 重录/通过，note 内零死链。

**验证证据。** `vitest.bench.config.ts` 全套 7 文件 41 测试在 M4/arm64/Node 25.8.1 实测全绿：session-open 首屏历史 ~837–976 ms、reopen agent-resume 中位 34.7 ms、128 MB 受限堆完成；agent-continuation request-history 68.07 ms（预算 297）、tool-continuation 199.45 ms（1125）、catalog 324.7 ms（1125）、profile ~980 ms；terminal-io 五 MiB 中位 104.4 ms（300）；long-session 浏览器 open 177/page 181/trajectory 263/first 242/streamTask 1458/streamWall 2285 ms，三样本 `inputOverlapped` 全真；conversation-fold 500k delta 大窗 fold 19.5 ms（40）；reconnect replace 13.36 ms（63）/驻留 22.27 MiB（30）。测量记录于 `upgrades/alignment/UPSTREAM-ALIGNMENT-PERFORMANCE-dsh-v0.1.6-alpha.2.json`（verify-upgrade-records 16 记录合规）。

**仍未关闭。** 全部数字为 arm64 参考机证据；标准托管 x64（ubuntu-24.04）上的 CI 实测尚不存在——上游 2× CI 时间系数与各终点托管预期已就位，首个真实托管运行后才能确认。浏览器计时含源解析测试 Host 与 Playwright 可动作性，不构成已发布 Host 证据。本批局部绿灯不得据以宣称发布就绪。

## 夹具世代迁移、回放确定性与门禁收口增量（2026-09-26，未提交候选）

本批在 `codex/fixture-replay-alignment` 工作树实现（含已提交基线与未提交收口改动），尚未推送或开放发布。对应 alpha.2 夹具/回放车道的剩余缺口：ACP 与语料 fixture 仍停留在无版本 `session.jsonl` 命名，回放归一化在并行子会话场景下绑定序不确定，写路径可产生非归一化不动点，外加全量门禁在满载并发下暴露的一批负载敏感测试。

**夹具世代迁移。** ACP 例子与 `snapshots/` 语料的当前 fixture 全部迁入版本命名（`session.v2/v4/v6.jsonl`，v0 沿用无后缀名），历史世代原地保留不更名不删除；v6 世代补全并把记录/刷新写路径限定为「每角色写最高当前世代」。`web-test-policy` 的 `sharedInputs`、Web e2e 与其 spec 中对已迁移 ACP fixture 的引用同步改到 `session.v6.jsonl`；Web 车道自有的旧世代 `session.jsonl`（v2–v4）属合法命名，未动。`session-format-catalog` 准入 CoHarness v0/v1 方言经逻辑链解析。

**回放归一化确定性（产品级竞态修复）。** 并行子会话场景的子会话令牌绑定此前依赖 harvest 数组序，与 LLM 回放按父会话 catalog 公告序认领 `liveSessionIds` 槽位的语义不一致，`subagent-parallel` 场景 pass/fail 摆动。修复把整条链路的规范键统一为父日志 catalog 首见序：`FIELD_KINDS` 认领 `childId`；`identity.ts` 改为逐日志交错认领（每日志先认其 header 再扫记录），取代全量 header 预认领；`harvestSessionLogs` 的子会话排序键改为父日志内容中 child id 的首见位置。stdout 逐帧归一化直接使用 context 的 `sessionIds` 顺序（该顺序即 harvest 产出的权威序）。

**写路径不动点。** `session/title-llm-request` 记录内嵌的 `data.messages[]` 此前不在 `recordMessages` 覆盖内：其消息 id 被 `preserveNormalizedVolatiles` 当普通易变字符串借入字面令牌并 `reserve()` 预占序号，写出的 fixture 呈稀疏编号、非归一化不动点。将该记录类型纳入 `recordMessages` 后刷新产出紧凑编号并收敛。`workspace.expected` 独立预言完整性同步钉死：共享 suite 的物化仅在 oracle 缺失时引导新场景，committed oracle 永不被 record/refresh 重写（语料政策要求）。

**scenario 手术。** `session-query-spill`：fixture 残留的 skill-catalog user/message 记录对应已移出组合面的 `skill-office`，删除后按事件前移同步 `seq` 引用、消息令牌编号与 `sourceEventSeqs`。`subagent-inheritance` 期望文件按新令牌方案（`{{session:N}}`/`{{message:N}}`、子头 `id/parent` 语义正确）刷新。两处迁移期残留的双角色 fixture（输入+期望同文件）就地升入 v6 并按名实一致更名 `session.v6.jsonl`。

**主权与依赖台账。** `atomic-write` 由 `tracked` 改 `adapted`（本地 exit 时释放文件锁系有意修复）；`skill-office` 等 fork 独有组合面在台账与审计中维持登记。knip 清零：fixture 入口按迁移后新位置补 entry（examples 旧副本仍被 ACP 车道 `cordis.yml` 使用，两份均保留）、仅经 yml 消费的包入 `ignoreDependencies`、`@yao-pkg/pkg` 按 spawn 二进制豁免、`verify-installed.ts` 补根 entry、`@types/js-yaml` 移除（js-yaml@5 自带类型）并重新生成 `THIRD_PARTY_NOTICES.md`。

**负载敏感测试加固（非放宽语义）。** 失败全部复现为「独立通过、门禁并发下超时/竞态」后逐个加固：`deepseek-defaults` fixture 空闲超时 150 ms→1 s 且 keep-alive 注释 6×200 ms（注释窗口仍大于超时，watchdog 判别力保留）；`built-boot` 单测超时 240 s；pwsh 三个真实 shell describe 统一 15 s；ptc-python 派生 CPU 预算改 `time.process_time()`（燃烧量与调度无关），两个内存/序列化用例抬墙钟预算与测试超时；HMR watch 两个用例与 model-governance 文件监听等待窗加大；session-snapshot `waitForTitleAfterTurnEnd` 补 `isolateDiagnosticTimeout`（与兄弟用例一致）；shell-activity 全文件 `expect.poll` 走 10 s 窗口包装；terminal-bash pwsh 套件两处按 scrollback 权威面改写（`done` 可先于输出 settle，`waitReason` 启发式胜者在负载下不唯一）；llm-pi-ai watchdog 的 socket 关闭竞态窗 1 s→10 s；oxlint-contract 六个真实子进程用例补 90 s 超时；plugin-manager/skill-office checkers/HMR transaction 用例补显式超时；session-snapshot harness `DEFAULT_WAIT_TIMEOUT_MS` 10 s→30 s（进度探测上限，非性能断言）；build-artifacts/client-build-environment/verify-web-fixtures/prepare/userdoc/code-block/tool-pwsh 按各文件既有惯例补显式超时。

**探针-构建竞态根治。** `oxlint-contract.spec.ts` 的契约探针按设计写入真实 tsconfig include 面（`packages/*/src`、`tests/`、`scripts/`）以验证逐类项目发现与生产/测试规则分层——与并发 `tsc -b` 枚举共享文件视图，探针在枚举后被删除即 TS6053（check:all 第六轮实发）。CI 各 job 独占工作区无此问题；本地修复用 run-gates 既有 `after` 原语把 check-all 的 `test` 串行在 `build` settle 之后（不传播失败，与 build↔typecheck 的 writer/reader 先例一致），整类竞态永久消除且不削弱任何契约断言。

**验证证据。** 快照套件 307/307（`subagent-parallel` 连跑 4 次稳定）；`pnpm run test` 全量 1442 文件 / 24493 测试 / 0 失败；`check:all` 收口轮 75/75 门禁通过（前轮历轮暴露的 test/test:snapshot/build 竞态全部按上述修复闭环）。生成物（doc graphs、markdown 链接、翻译配对、THIRD_PARTY_NOTICES）全部重跑通过。

**仍未关闭。** 验收 runbook 的环境依赖项在本机工作树无法关闭：真实双人 LAN/公网验收、release-freeze 移除、CI 平台矩阵、生产形态备份恢复演练、Linux/Windows Python SDK 构件、桌面 computer-use/browser-use 与 Office WASM Linux 环境验收。GUI 可见行为改动的浏览器 GIF 属 PR 随附义务。本批局部绿灯不得据以宣称发布就绪；提交、PR 与合并由用户执行。
