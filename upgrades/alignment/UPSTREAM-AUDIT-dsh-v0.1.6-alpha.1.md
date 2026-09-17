# 上游对齐审计 — dsh-v0.1.6-alpha.1

## 执行基线与验证记录

- 记录来源：`ef13d3f068`（Phase 0 三件套）恢复到主线 `master`（`409253c092`）之上；两棵本地树在 `packages/core/agent`、`packages/core/agent-loop`、`upgrades/`、`scripts/upstream-sync.json` 上无差异。
- 升级记录门：`verify-upgrade-records` 14 份记录通过；`verify-md-links` 2492 个文件、`verify-md-wrap` 2458 个文件通过。

## 干净基线测试（409253c092，实施前）

全量单测 1065 个文件通过、2 个失败（244 项）：`packages/experimental/code-runtime-python` 的 `boot-write-failure.spec.ts` 与 `runtime.spec.ts`。失败原因全部为 `config.pythonBin "/usr/bin/python3" must be CPython 3.10 or newer, got cpython 3.9.6`——宿主系统 Python 3.9.6 低于该包的运行要求，属环境性既有失败，与本次升级改动无关；修复属于环境准备（安装 Python ≥3.10），不阻塞其他阶段。

Lint（oxlint）0 告警 0 错误。

## 本次实施验证（Phase 2 首项：发布回滚）

- 新增 `interception.spec.ts` 回滚测试：`session/created` 与 `agent/created` 抛出时，create 以原始错误拒绝、Agent 与 Session 注册表已清空、同一 id 可立即重建（无轮询等待）。实施前两条测试在未清理状态下失败，实现后通过。
- 生命周期面全绿：interception 25、scope-lifecycle 38、resume 28、config-session-id 16。
- `tsc -b packages/core/agent-loop` 通过；局部 oxlint 0 警告 0 错误；`git diff --check` 干净。
- 未验证：真实 provider e2e、组装快照、TS/Python SDK 输出——本批为私有发布操作，不改公开事件与 Session schema；完整迁移（串行 `agent/created`、首轮输入屏障、消费者与 SDK 输出）仍未实施。

## 实施后全量复跑（c980a7e7b7）

全量单测 1067 个文件、18150 项：4 个文件失败。对比实施前基线：Python 3.9.6 环境性失败不变；`app-boot/tests/hmr-config.spec.ts` 与 `session-persistence-jsonl/tests/lease.spec.ts` 在全量并发下失败、单独重跑全部通过（23 项），属资源争用型不稳定，与本次改动无关。无本次改动引入的失败。


## Phase 2：发布期间输入暂存

- setup 和发布复用维护操作，成功才释放排队唤醒；失败时先取消唤醒再回滚，避免尚未成功创建的 Agent 开启模型轮次。
- disposed 取消会清除唤醒标记，即使先前已发生保留收件箱的普通取消；状态回调卸载根作用域时，未启动的驱动结算完成，不阻塞清理。
- AgentLoop 单测 19 文件、359 项通过；聚焦 interception 32 项与 cancel 37 项通过；包级 TypeScript 编译和局部 oxlint 通过。审查补充两条回归，确认普通取消保留输入但清除旧唤醒，之后的新输入仍可唤醒。
- Headless 产品与 TypeScript SDK 快照共 22 项通过；新增发布失败快照输出 `publication turn started: false`，其余已有预期输出不变。
- 公开创建事件仍为同步事件；串行事件、消费者迁移、Python 打包运行时快照、真实 provider 和桌面能力验收未完成。本批未重复执行仓库全量单测。

## Phase 2：串行创建与启动 hooks

- `2d893a6eb9` 引入串行 `agent/created` 与 Codex 启动等待；Claude Code 的 SessionStart 同样在初始化中等待，创建取消与桥接卸载会中止并等待进程清理，不注入迟到上下文。Hook 失败保留记录但不否决创建。
- `235cfdedc7` 修正测试消费者的异步 registry disposer 类型与等待；相关 5 文件 161 项测试通过，6 文件类型感知 lint 0 告警、0 错误。
- Claude 桥接 6 文件 69 项测试、包级 TypeScript 编译、局部 lint 通过。Headless 与 TypeScript SDK 原集合 23 项通过，包括真实 Claude 启动 hook 的首请求上下文和持久来源检查；未放宽请求次数断言或改写已有预期。
- 本批全量测试首次 1058 文件通过、9 文件失败，构建通过。在测试进程 PATH 指向宿主 Python 3.12 后，原 9 个失败文件集合最终复跑 516 项通过、2 项跳过。此前复跑出现过 Python 清理耗时 4074ms 超过 4000ms，快照出现过请求数 2 而非 1；隔离和原集合后续复跑通过，原因未确定，不据此宣称全量稳定性已解决。耗时和请求数断言均未修改。
- 待完成：goal、goal-round-driver、agent-team 旧启动事件消费者迁移与旧事件移除；Python SDK、真实 provider、桌面与 LAN/公网验收。各阶段状态仍以升级计划为准。

## Phase 2：旧启动事件移除与全量验收

- goal、goal-round-driver、agent-team 已迁移到串行 `agent/created`；旧事件类型、发布通知、scoped resolver 和生成目录条目已移除。生产源码与测试消费者搜索无旧事件引用。
- 创建期间入队后取消并保留 inbox 的回归通过：创建返回并 idle 后零模型请求、无 `turn/start`，新输入仍可唤醒保留消息。Headless 与 TypeScript SDK 快照 23/23、构建、类型检查和 lint 已通过。
- 本批首次全量 18047 项通过、4 项失败，失败为 ACP 子任务/标题等待诊断和 Python CPU/宽值用例。受控阻塞首次标题日志读取复现通用超时，修复保持原期限与谓词，保留场景诊断和最近观测错误；完整 harness 文件 63/63、包测试 224 项通过及 1 项跳过。
- 修复后使用 Python 3.12、原并发和超时配置执行 `pnpm test`：1067 文件通过、9 文件跳过；18052 项通过、116 项跳过，退出码 0。子任务诊断与两个 Python 用例未修改实现或放宽断言，本次全量通过不代表既往偶发失败根因全部解决。
- Python SDK 打包产物、coverage、独立 Gateway/插件业务回归、真实 provider、桌面和 LAN/公网验收尚未由本批完成。同步基线不前移，整次升级仍在进行。

## Phase 1：Node 内部加载器依赖

- CLI 与 vendored Loader 的 `node-addon-require-builtin` 声明对齐上游为 `^0.1.6`；pnpm 锁定主包、原生平台包及 `node-addon-native-custom-loader` 为 `0.1.6`。两处实际解析路径均为新版本，宿主 Node 25.8.1 的内部 ESM loader 读取与兼容测试通过。
- 锁文件由 pnpm 11.7.0 生成，附带范围内更新：`@testing-library/dom` 10.4.2、`compression` 1.8.2（新增 `destroy` 1.2.0）、`negotiator` 1.1.0、`proxy-addr` 2.0.8，以及 Vite 的 `picomatch` 引用 4.0.7。未修改这些包的 manifest 范围；本批回归覆盖此完整锁文件，而非仅原生扩展。
- `pnpm install --frozen-lockfile` 通过；未新增安装脚本授权或版本年龄豁免。Include 的 js-yaml 5 适配、Loader API 检测和 HMR 行为保持不变；vendor 源码同步与跨平台原生验证仍待完成，整次升级基线不前移。
- 本批 `pnpm test`（Python 3.12，原并发及超时）退出码 1：18050 项通过、2 项失败、116 项跳过。失败为 `user-patches.spec.ts` 的默认组合配置未更新，以及 Python runtime 的输出上限预期得到 timeout。`pnpm run build` 退出码 0；构建后的 Loader 在普通 Node 进程中通过原生扩展解析 `node:path`。
- 原 HMR 失败单项隔离通过，随后完整 app-boot 包为 108 通过、1 失败（同一用例的首次配置添加未生效）；再串行隔离 3 次均通过。未改超时、断言或 watch 实现，尚不能确定依赖变更与失败的因果关系。本批保留为待验收，不以隔离通过替代完整回归。
- 第三次全量确认运行在 coverage partition 3/3 阶段被主动终止，未产生最终结果；提交时全量套件状态以第二次运行为准（18050 通过、2 失败），批次按待验收提交。

## Phase 1：非事务 Loader 适配（工作树，待验收）

- app-boot 启动失败断言已对齐结算后审计；插入插件路径锚定、用户 patch 重载诊断和 webserver 激活失败的定向集合为 7 文件 95 项通过。app-boot 完整集合为 115 项通过、2 项失败；聚焦 `tsc -b packages/boot/app-boot` 退出码 0。
- 两个原生监听用例仍失败：文件新增/变更/删除，以及注册时父目录不存在。单项原生错误捕获记录 `EMFILE: too many open files, watch`（errno -24），进程软／硬描述符限额均为 unlimited；不修改生产监听实现、不切换轮询、不放宽超时，原生监听验收继续作为环境阻塞保留。卸载期间打开 watcher 的定向生命周期用例通过，不据此推断所有资源泄漏均已排除。
- 本轮全量单测使用 Python 3.12、fresh TMPDIR 和 `--no-file-parallelism`：1061 文件通过、6 文件失败、9 文件跳过；18052 项通过、8 项失败、116 项跳过，退出码 1。除两个监听失败外，Web boot-client 仍期待旧导入错误文案；agent-spine-demo 缺少新建 skill 的目录输出；directory-picker-auto 和 tool-todo 三项拒绝断言触发 PrettyFormatPluginError；plugin-package-inventory-deepseek 缺少第二个包版本。后五类失败的根因与消费者适配仍待核验，不全部归为监听环境问题。
- 随后构建退出码 1、全局类型检查退出码 2，均报告 `packages/extensions/cordis-client-runner/src/client/runtime.ts:465` 的 TS2339：对返回 void 的 `Fiber.update()` 调用 `.catch()`。这是尚未适配的消费者，包级类型检查通过不能替代全局检查。
- README 双语已区分更新前解析失败与非事务激活失败：后者不保证恢复旧树；配对记录已更新。`doc-sync` 首次为 26 通过、2 失败：Cordis Fiber 目录过期，以及两份旧 Agent Note 的双语页面仍引用已移除的 HMR 测试文件。Fiber 目录经生成器更新后，`verify-cordis-catalog` 通过；旧 Note 的语义更新、失效路径及本批 Agent Note 尚待完成。
- 尚未完成本批组装快照、全量回归收口和 vendor 本地差量日志核验；profile-resolution 与 required-startup 策略继续推迟。此次记录不推进同步基线，不表示 Phase 1 或整次升级已完成。

## Phase 1：非事务 Loader 适配收口

- 收口范围：app-boot 与其余 Loader 消费方适配为激活后审计，vendor/Typert/依赖底座同步；第二阶段起的目标不进入本批。上游 `profile-resolution` 的 worker/runtime resolver 归属发布闭包，按计划保留推迟。
- 上游 Typert-loader 语义补齐：包子路径条目退出自动发现、显式 `packages` 拒绝配置的子路径，npm 别名按 manifest 包名校验产物。本地保留 `createRequire` 原生解析（上游走 `pluginPackages` 解析服务，属发布闭包差异），`packages/typert/loader/tests/loader.spec.ts` 17 项通过，双语 README 记录该语义。
- `vendor/README.md` 本地差量第 2 条更正为 `node-addon-require-builtin@^0.1.6`，与 vendored manifest 和 CLI 运行时依赖一致；Chokidar 运行时版本为 4.0.3（package.json、lockfile、解析一致）。
- 验证（Python 3.12）：`pnpm run test` 退出码 0（1067 文件通过、9 跳过；18075 项通过、116 跳过），含 `watch-config.spec.ts` 11 项；`pnpm run build`、`pnpm run typecheck` 退出码 0。此前三条 5 秒超时（Claude/Codex hooks、Landlock 后台分类）在最终全量未复现，三条文件定向串行 42 项通过、单文件 verbose 9 项通过；未修改超时、断言或 watch 实现。
- 本地检查通过：`pnpm run lint`、`pnpm run doc-sync`（28 项）、`verify-upgrade-records`（14 份记录）和 `verify-translation-pairing` 均为退出码 0；`git diff --check` 通过。
- 补充现有组装回归：`pnpm run test:snapshot apps/cli/tests/dsh-badge.snapshot.ts examples/headless-agent/tests/session-format-guard.snapshot.ts` 退出码 0，2 文件、3 项通过，未改写预期输出。覆盖 CLI 技能组合和 Headless Session 格式拒读，不代替新增激活失败诊断的专用快照。
- 新增缺失服务的激活审计快照：复用 Headless 启动脚本和 `runLoaderSmoke`，真实 Loader 组合中启用的条目等待不存在的服务，断言退出码 1、stdout 为空及 stderr 的完整诊断；所在文件 3 项通过，无新增 fixture 或超时调整。
- Phase 1 的表列 test/build/typecheck 验收及激活诊断组装快照通过。Phase 2 已部分实施，剩余项与后续阶段（含 profile-resolution/required-startup 的发布闭包处理、真实 provider、SDK 输出与平台验收）按计划表继续跟踪；同步基线不前移。

## Phase 2：串行预设、Session 消息投影与运行时验收收口

- 常驻预设的 scoped installer 返回 memoized inject fiber，串行 `agent/created` 等待安装结算；冲突使创建拒绝并回滚 Agent/Session，释放 id 后可重建，首请求包含预设工具。移植回归先 RED 后 GREEN；相关目录 28 文件 518 项通过。
- Session 接入 fiber 所有的纯消息解释器、提交前完整决策验证、内容代次缓存失效及卸载拒读；create/restore/fork 和 detached fold 共用定义。上游投影回归 5 项先失败后通过；必需解释器采用测试专用类型，生产目录不提前引入第三阶段图片事件。生成器识别 `@messageProjection` 并拒绝双重 surface 声明，26 项通过。保留绝对序号窗口、恢复所有权、packed chunks 与不可变代次，不提升格式版本。
- CLI 动态安装 watcher 依赖后等待 Loader 结算并执行激活审计，再启动 patch watcher；原先缺少 HMR 的产品启动 4 项回归保持原断言通过。测试插件相对 patch 文件解析；激活错误快照仅更新已确认的非事务 Loader 诊断，原始错误及堆栈保留。此组装适配依赖未提交的 Phase 1 底座，不将底座源码夹入本阶段提交。
- 汇总验收：Python 3.12 `pnpm run test` 退出码 0，1069 文件通过/9 跳过、18082 项通过/116 跳过；`pnpm run build` 退出码 0；`pnpm run doc-sync` 28/28；Headless 全目录与 TypeScript SDK 快照 10 文件 34 项通过，正常 SDK 转录不变。`pnpm run lint` 全库 3243 文件 0 警告/0 错误，最终 CLI 补丁另经类型感知 lint 验证。
- Python SDK 使用 `pnpm exec tsx scripts/build-exe-for-python-sdk.ts --skip-build` 生成真实 macOS arm64 carrier，`smoke-python-runtime.py --scenario sdk-snapshot --exe dist-exe/deepseek-harness-sdk-runtime-macos-arm64` 退出码 0；不是用 Python 单测替代运行时输出。production deploy 影响根依赖检查后，按锁文件恢复开发依赖再验收；保留失败记录，不修改超时。
- 本地业务回归：Gateway 3 文件 26 项、Agent/Gateway 持久化与协作消费者 9 文件 177 项通过。覆盖创建、恢复、fork、失败、取消和父属语义。真实 provider、coverage、桌面、LAN/公网、平台矩阵及发布闭包归后续阶段；同步基线不前移，不表示整次升级完成。
