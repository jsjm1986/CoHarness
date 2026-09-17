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
