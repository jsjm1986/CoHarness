# CoHarness 对齐 DSH v0.1.5-rc.2：云端协作版收口计划

- 审查日期：2026-09-13。
- CoHarness 基线：`caed29fdd0964f3efe5e59101bbd1446539c9b26`（`origin/master`，含 CI 分层、Web sweep 与文档归档修复）；用户工作树中的 `UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.1.5-alpha.1.json` 保持不动。
- 上游链路：`dsh-v0.1.3-alpha.2` `82a5fd61a7cf5c293cec4bdff68f455398d685e9` → `dsh-v0.1.5-alpha.1` `5dda764ed3aa172535a7967b06ff95d9cbfe536a` → `dsh-v0.1.5-alpha.2` `b2e3b2a0125854567a4a5fcba75782e42fe84901` → `dsh-v0.1.5-rc.1` `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` → `dsh-v0.1.5-rc.2` `fb2c4b9e698e30edb738bca4cf0618587db7d203`。
- 本轮目标版本：`0.1.5-rc.2.coharness.1`。

## 取舍原则

上游变化按业务责任、wire/API、Session 数据生命周期、Gateway ACL、Cordis 插件角色、性能和发布回滚逐项核验。`retain` 表示 CoHarness 业务 owner 继续权威，`equivalent` 表示已有等价实现，`adapt` 表示在现有 owner 内吸收行为，`required` 表示缺口必须补齐，`defer` 表示需要独立产品决策，`reject` 表示会破坏云端安全边界。

## 已确定的适配方向

- CoHarness 已有 Session V3、显式 Agent API、迁移代次保护、双流连接和子代理生命周期等实现。旧升级记录只能说明既有机制，不能证明本次累积差异全部等价；必须继续逐项读取源代码并补测试。
- rc.2 的 V41 默认模型和交付文件视觉优化采用；模型治理、BYOK、配额和项目默认设置仍优先于上游默认。
- Workspace 文件是面向云端 Web 的新增只读能力。本轮以现有 ApiProxy、Gateway ACL 和 `ctx.fs` 接入，地址只含 Session 与相对路径；不开放绝对路径、写入或服务器 `openPath`。
- User Documents、反馈 sidecar、Workbench 多 runtime、Android、native 和部署流程继续保留独立业务语义。

## 当前工作树的增量（尚未发布）

1. `ctx.fs.readByteRange()` 在 local 与 E2B provider 中实现，local 使用单个 bounded FileHandle，E2B 在窗口完成后取消远端流；fake provider、目录、API catalog、双语文档和测试同步更新。
2. ApiProxy 增加 `workspaceFiles.list/stat/read/readBytes`，在每次调用重新执行 Session ACL、relative path 校验、component lstat、canonical containment、symlink 拒绝和最终 stat；响应只返回相对路径、opaque version、分页文本或 Base64 字节。
3. Host 双流增加 `host/workspace-file-changed`，只转发 Agent `fs/observed` 的相对路径和版本；不转发 `FsTargetKey`、`processPath` 或宿主绝对路径。
4. Client runtime 增加 `WorkspaceResourceRegistry` 和 `workspaceResourceProvider(api)`。资源按明确的 bootstrap/project runtime 与 Session 地址绑定，共享 metadata；Host 配置限制数量，支持 pin/release、取消、失败保留、访问失效清除和重连复核；资源内容仍通过有界 RPC 按需读取。
5. V41 Flash 加入 DeepSeek provider 默认目录和 base bundle 的默认模型；V4 Flash、V4 Pro 和 Vision Exp 继续保留，显式用户或 Gateway 模型选择不被覆盖。
6. Workbench 文本预览已接资源状态和版本分页；云端路径点击不会调用服务器 `openPath`。已增加云端目录浏览、二进制 Base64 窗口回退、上游文件类型图标和反馈提交确认；统计 pill、重试/紧凑流展示和旧模型选择回归已在本地 Web 回放验证，完整 golden 刷新仍需继续。
7. 目录授权插件增加 Workspace 读取检查；Gateway 的已提交访问变更可关闭本进程内受影响的在途 HTTP 与 WebSocket。跨 Gateway 实例广播、私有可见性与浏览器清屏端到端验收尚未完成。
8. PR-7：非持久化 Code Mode 术语对齐上游 PTC——`code-mode.ts`→`ptc.ts`、`CodeDispatch*`→`PtcDispatch*`、`tools-code-mode`→`tools-ptc`、preset `code`→`ptc`、`tools:code-only`→`tools:ptc-only`；旧持久标识符（`tool/code-dispatch*` 等）保持可读，历史不透明标识符逐字不变。
9. PR-8：Inbox 实现搬入 `agent-loop`（`ReactLoopInbox` 走 `agentInbox` 投影，`agent` 仅保留接口）；`subagent` 增加父属 `subagentCatalog` 持久投影（`dsh-chunked-list` 块存储）、continuable activation/queue/steer/interrupt 控制面与 descriptor v3（`reasoningEffort` 快照）；保留 CoHarness 的 `maxMessages`/`maxBytes` 配额、`maxActivations*` 上限、附件准入、图像能力与协作授权；`listChildren` 维持语料+身份投影三阶梯读取，属记录分歧。
10. PR-9：rc.2 细项收口——V41-Flash/V4-Pro catalog `description` 字段、`tool-subagent` 模型选择迁移到 `sessionProjections` 投影（`subagentModelSelectionProjectionDefinition` + 上游 harness/三个 spec，本地无 policy 时 fail-loud 的分歧保留并补测）、`SECTION_ORDERS`/`CONTEXT_ORDERS` 常量化、`llm-pi-ai` 四个 compat 字段与 `vllmPriority.step(1)`、open-in-app SSH 启动短路（`launchedThroughSsh`/`launchEnvironmentOf` 收敛为共享导出 + `ctx.get('connection')` 可选围栏）、出站代理验证面（`verify-no-bare-dispatcher` AST 门禁入两个静态门禁集、`test-proxy-environment` 清八个代理变量挂入三份 vitest setup、九包 egress spec + web-fetch `proxy.spec` 共 30 项、web-fetch-http `proxyRouteFor` 分支、network-proxy 用户指南三件套上站、`2026-08-27-outbound-proxy-policy` note 三件套）。`ui-message-feedback` 确认流与 `ui-deliverables` 云端安全面核验保留；`tool-bash-persistent` 与 `model-selection.ts` 核验与上游逐字一致；`session-turn-outline` 裁决不移植（`ui-conversation` 自有 `sessionStats`/`TurnNavigator` 等价物）。
11. PR-10：Session 写锁升级为内核租约——新增 `lease.ts`（`SessionWriteLease`：POSIX 经 `@deepseek-ai/node-addon-system/flock` 已发布 npm 依赖做非阻塞 `flock`，加锁后校验所锁 inode 仍是锁路径文件、被替换则重试；Windows 经 `win32.ts` 新增 `CreateSemaphoreW` 命名内核信号量），`acquireWriteLock` 由"创建+pid 探测"文件锁改为内核租约；保留旧 `{pid}` 记录双向互斥（活 pid 拒绝、死/残记录进入 flock 仲裁、持锁回写自身活 pid）；`.locks/<id>.lock` 释放后刻意保留以稳住 inode。`lease.spec.ts` 14 项 + 构建产物真双进程 `lease.two-process.e2e.ts`（持锁排斥→SIGKILL→即时接管）；README 双语、`2026-08-31-cross-process-session-write-lease` note 三件套与矩阵 `session-handle-single-writer` 行更新。
12. PR-11：subprocess runner 重建的累积源代码审查完成——上游把 `subprocess-local` 重构为私有 runner（`bin.ts`、`runner-launch`/`runner-protocol`/`spawn-runner`、`managed-owner`），其净新增收容仅 linux-scope（已在 `linux-process-cancellation` 行延期至 Linux 宿主机验证）与 windows-job（需新增 `@deepseek-ai/dsh-win32-process` 包与 CI 持有的 Windows 验证）。本地 fallback owner 语义已与上游逐语句等价：detached 进程组、负 pgid 信号、`linuxProcessGroupHasLiveMembers` 僵尸组细化、整范围 `waitForExit`、同步 host-exit 终结、TERM 陷阱保有、PID 复用栅栏与 `settleExitIfGone`。已移植宿主机可验证的剩余项：主 spawn 与两处 taskkill 助手的 `windowsHide`，及惰性 Toolhelp32 枚举的 spec 断言。runner 机制（spawn seam、managed-owner 分派、terminal managedOutcome/raceWithDelay/running getter）随其收容路径一并延期；本地保留 `terminalInspector` 公共缝的刻意兼容面（`processTree`/`processSession`、可选 `snapshot`）。矩阵 `shell-terminal-runtime` 行记为 `deferred-platform-review`。
13. 矩阵累积源代码审查收口——剩余七行全部完成源码审查并记录裁决：`ui-package-tree` 与 `native-desktop-and-electron` 裁决 reject（上游整树 rc.2 新增：ui-chat/ui-session/桌面侧栏/approval/dockkit/file-upload 及 Electron apps/desktop* 均为桌面专属或已有云端等价面）；`client-ui-surface`、`core-tools-and-context`、`api-host-goal-boot` 裁决 adapt（反馈确认流、云端 ProducedFiles、ui-conversation StatsPills、PTC 术语、workspace-files ACL、open-in-app SSH 短路、goal pause 均已核验；tool-present 维持产品决策延期）；`cordis-typert-tooling` 裁决 adapt（generator 五个 src 文件与上游逐字一致：stream-mode `AsyncIterable` 签名、共享 `WorkspaceCaches` + `checkDiagnostics`、cordis-catalog 正则转义修复与 file-only sourceLink、双语 banner 措辞；protocol 保留 Gateway 授权类型超集）；`residual-carried-surface` 裁决 adapt——移植 MCP `tools/list` 重复游标拒绝（含两个 spec 用例）、`JsonValue`/`assertNever` 迁入 `dsh-util-values`、compaction 影子计价拆分（`shadowedTokenCount` 带启发式价供投影折叠、新增 `shadowedRouteTokenCount` 供收缩比较）、`TokenSurfaceNode.heuristicTokens` 必填化、token-meter anchor 重建为原始事实（pre-assistant 节点 + assistantTokens + usage 逐次测量推导）使路由定价下的基线正确重定价。SDK `launch.ts` 维持 upstream-only（云端 SDK 远程连接）。上游 file 附件计价链（file 内容块、`MeterSurfaceNode` 结构事实、plan/commit 折叠）仍为 `llm-and-metering` 行的记录分歧。

## rc.2 之后主干审查补充

上游 `dsh-v0.1.5-rc.2..master` 的逐项审查还发现两项必须纳入本轮适配的核心变化：

- `165cc31eb8` 的紧凑 Assistant stream 读取：token-meter 从 `assistant/attempt` 嵌入流读取最后 usage，session-stats 从记录读取首 token，避免为统计物化完整流；`llm/retry-started` 后的同一步重试累计为独立计费 attempt。
- `a64dc3a690` 的 V41 图片 token 算法：544×544 像素下限、14px patch、每轴 3:1 下采样、单图 1,024 token 上限。它只改变启发式请求计价，提供方实际 usage 仍覆盖估算。
- `165cc31eb8` 与 `3997f36999` 之后的统计展示链路已经在 CoHarness 的 composer dock 和 turn tail 中接入；仅在持久记录能证明精确总量时显示 per-turn 用量，避免把缺失的 cache-write 或 total 伪造成零值。
- `2c9eda5b6f`、`5b1bb021cf`、`c75e100893`、`996278e6ce` 的命令展示行为在现有 Slot/输入流水线内适配：definition identity、标题/描述本地化、分组、共享图标和标题模糊搜索加入，命令执行仍按 CoHarness 的 canonical name、图片信封和 ACL 语义。
- `1f1537914f` 的持久 Bash 模型可见状态标记加入现有 owner-scoped PTY：成功命令始终报告退出码，超时报告专用标记，环境描述不再假设网络；一次性 Bash 与 pwsh 的独立标记契约保持不变。
- `d79294f23a` 的仓库文件 dirent walker 适配到静态文档门禁，避免 Node 24 在 `**` 扫描符号链接文件时抛出 `ENOTDIR`；它只替换 CI 文件枚举实现，不改变产品路径。

这两项不改变 CoHarness 的 SessionEvent wire、Gateway ACL、Documents 或 Workbench 路由；前者使失败重试和紧凑日志的计量可重放，后者修正当前默认 V41 模型的上下文压力估算。上游的 agent preset 选择器开关（`c31ac4fdfe`）属于账户产品设置，暂列 `defer`，等待云端租户默认值与权限策略确认，不直接复制上游 UI。

## 未采用的上游实现

- 不直接引入 `session-controller`、`client/store`、`ui-chat`、`ui-sidebar-right`、`ui-sidebar-files` 或 `ui-sidebar-textpreview`；这些会替换已有多 runtime、Documents、SlotRegistry 和 Gateway owner。
- 不把 Workspace 文件写入、OS watcher、绝对资源地址或 E2B host path 暴露给浏览器；Agent 工具、CAS 和审计仍是唯一写入路径。
- 不将上游 Electron、CI-only、webhook 和 Remote Gateway 控制面变化伪装成本次云端同步（`native system/flock` 已由 PR-10 经已发布 npm 依赖正式采用）。

## 后续收口门禁

- 为 Workspace file RPC 增加 Gateway project `ro/rw`、private/project、撤权和 principal expiry 组装测试；撤权必须结束 stream 并清除客户端内容。
- 补齐 runtime resource provider 的 reconnect、multi-runtime、idle eviction 和 abort 测试；将 Host change frame 接入现有 Workbench 可选文件区域后再更新浏览器 snapshots。
- 运行 Session/persistence、Agent/AgentLoop、LLM、ApiProxy、Connection、runtime、conversation/tool/Workbench、Documents、Gateway 重点测试，以及 `typecheck`、`build`、`lint`、`hygiene`、`doc-sync`、包不变量和浏览器分层门禁。
- 在 Linux、Windows、macOS x64、E2B、真实 Gateway PostgreSQL、真实 LLM API 和生产回滚环境完成外部验收后，才把本轮版本标为 released。

## 当前验证证据

条目 1–7 的证据来自 `/private/tmp/coharness-rc2-upgrade` 的未提交工作树；条目 8–9 的证据来自 `/private/tmp/coh-mainline` 的未提交工作树。均不是已合并 CI，也不证明未测项目通过。

- 本地 FS 与基础 RPC：77 项通过，覆盖带版本读取、替换、symlink swap、分页提前停止和取消。
- Workspace RPC：11 项通过，覆盖冷 Session、`ro/rw` 读取、授权前置与完成前复核、目录授权插件卸载、大小限制、版本冲突与过期。
- Client resources：25 项通过，覆盖地址校验、runtime 隔离、取消、pin/release、缓存淘汰与旧代次丢弃。
- 路由与相关消费者：5 个测试文件共 112 项通过；之后新增的连接错误分类测试需继续复跑。
- Gateway：3 个测试文件共 53 项通过，包含已建立 WebSocket 的注销关闭及在途 HTTP 的中止。该组使用 SQLite 测试服务与真实代理，不是 PostgreSQL 双用户资源验收。
- 尚无本轮内存、远程传输、React commit 性能测量，也尚无 Windows、macOS x64、E2B 实机与生产回滚证据。Web 回放全量清单（95 个场景文件）在 `DSH_SNAPSHOT=replay` 下全绿，见下方终审复演。

- 新增的紧凑流 usage/首 token 读取、同一步重试累计，以及 V41 图片计价的定向测试已通过；真实提供方缓存和图片 usage、跨平台运行与生产回滚仍未验证。

- PR-8 验证：`agent-loop` inbox spec 9 项通过；subagent 目录 31 个测试文件 715 项通过；受 inbox 迁移影响的 149 个 spec 共 3,944 项通过；keyless snapshot 刷新与回放通过（宿主机 `all_proxy` SOCKS 警告属环境噪音，未编码进期望输出）；`typecheck`、`doc-sync` 各叶、`verify-archived-agent-notes`、`verify-agent-note-format` 均绿。`duplication` 全仓克隆率经 StatsPills/StatsLine 共享 `window-stats.ts`、`attachment-local` 复用 `dsh-attachment` 的 `requestImageDimensions`、`ui-conversation` 改用 `ui-primitives` 的 `ReferenceIcon` 后降至 0.11%，低于 0.115 阈值。
- PR-9 验证：`tool-subagent` 128 项、`llm-deepseek` 聚焦 404 项、egress 两批共 30 项、`open-in-app` 54 项、`session-stats` 18 项、`token-meter` 67 项、代理门禁与环境 spec 26 项、web-fetch `proxy.spec` 7 项、`api-proxy-models` 17 项通过；`verify-no-bare-dispatcher`、`verify-package-dependencies`、`verify-optional-dependency-imports`、`verify-upgrade-records`、`verify-translation-pairing`（1,214 对）、`verify-agent-note-format`（767 篇）、`docs:check`（站点构建 + 2,494 个 fragment）、`build:lib:host` 与 `typecheck:contracts-ready` 均绿。token-meter breakdown 投影与上游 positional surface-node 模型的机制分歧记录在 `llm-and-metering` 行，留待专项复核。
- PR-10 验证：`lease.spec.ts` 14 项、`lease.two-process.e2e.ts` 1 项（构建 lib 下真子进程持锁→排斥→SIGKILL→即时接管）、`session-persistence` 系列 17 文件 673 项通过；`verify-package-dependencies`、`verify-export-jsdoc`、`verify-upgrade-records`、`verify-translation-pairing`、oxlint、`git diff --check` 均绿。Windows 信号量路径由 CI 原生覆盖，本机未测。
- PR-11 验证：`spawn.spec.ts` 81 项（含新增 `windowsHide` 两处断言）、`windows-inspector.spec.ts` 10 项（含惰性枚举断言）通过；`verify-upgrade-records` 绿。runner 重建经累积源代码审查裁决为延期：净新增收容均要求本机不可得的平台验证（systemd scope→Linux、Job object→Windows+dsh-win32-process），fallback 语义已等价。
- 累积源代码审查验证：typert 10 个测试文件 222 项通过（`gen-cordis-catalog` 重新生成 91 页 file-only Source 链接并逐字复现）；`mcp-client` 59 项（含两个游标环回用例）、`compaction-basic` 83 项（含三个 route-priced 压力用例）、token-meter 67 项通过；mcp/compaction/token-meter 聚焦共 368 项通过；workspace `tsc -b` 全绿；`verify-upgrade-records`、`verify-translation-pairing`（1,216 对）、oxlint 均绿。剩余分歧全部在矩阵行内显式记录：Linux/Windows 原生收容（`deferred-platform-review`）、tool-present（产品决策延期）、file 附件计价链（`llm-and-metering` 行记录的既有分歧）与 SDK 客户端 `launch.ts`（`residual-carried-surface` 行：云端 SDK 远程连接，保持 upstream-only）。
- 终审复演（按 CI 分车道单独执行，机器空闲）：`check:ci:static` 42 门全绿（含 `verify-no-bare-dispatcher`、`verify-upstream-sovereignty`、`verify-upgrade-records`）；`check:ci:consumers:scoped` 9 门全绿（build、publint、node-next、built-package-invariants、built-bin smoke、lint+duplication、`test:snapshot`、doc-typecheck）；`test:coverage` 单独执行 1,044 文件 / 17,536 项通过且无 per-file 阈值违规，唯一失败是 `code-runtime-python` 探针用例在覆盖率插桩下超 5s 默认超时（CI 车道设 `DSH_COVERAGE_TEST_TIMEOUT_MS=30000`，无插桩单跑 250/252 通过）；coverage-exempt-heavy 255 项通过；Python SDK keyless 套件（CPython 3.10.21，消费构建后的 `sdk-runtime` 闭包）60 通过 / 10 跳过；Web 全量 95 个场景文件 0 失败。复演暴露并修复一项真实回归：`validateSessionEventData` 移植后，16 个 v3 之前录制的 web fixture 在 `request/header` 上仍带 `system` 占位符，直接写入当前代次日志时被拒绝——按“修 fixture 不修 normalizer”剥离该字段；生产侧 v3 之前的日志经 v2→v3 迁移把 `header.system` 迁入 `system/message` 头，不受影响。把整张 `ci-primary` 图在单机并行执行会因资源饱和产生超时与 lint 探针文件竞争，不构成代码失败证据。

当前未升版本、未提交、未推送。累积审查范围包含 580 个非合并上游提交，其中 alpha.1→rc.2 有 200 个；数量仅用于检查库存完整性。矩阵 25 行已全部完成逐项源代码审查并记录裁决；未决项以各自行的延期/分歧记录为准，不得标为全部对齐。
