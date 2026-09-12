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
- 不将上游 Electron、native system/flock、CI-only、webhook 和 Remote Gateway 控制面变化伪装成本次云端同步。

## 后续收口门禁

- 为 Workspace file RPC 增加 Gateway project `ro/rw`、private/project、撤权和 principal expiry 组装测试；撤权必须结束 stream 并清除客户端内容。
- 补齐 runtime resource provider 的 reconnect、multi-runtime、idle eviction 和 abort 测试；将 Host change frame 接入现有 Workbench 可选文件区域后再更新浏览器 snapshots。
- 运行 Session/persistence、Agent/AgentLoop、LLM、ApiProxy、Connection、runtime、conversation/tool/Workbench、Documents、Gateway 重点测试，以及 `typecheck`、`build`、`lint`、`hygiene`、`doc-sync`、包不变量和浏览器分层门禁。
- 在 Linux、Windows、macOS x64、E2B、真实 Gateway PostgreSQL、真实 LLM API 和生产回滚环境完成外部验收后，才把本轮版本标为 released。

## 当前验证证据

所有证据来自 `/private/tmp/coharness-rc2-upgrade` 的未提交工作树；不是已合并 CI，也不证明未测项目通过。

- 本地 FS 与基础 RPC：77 项通过，覆盖带版本读取、替换、symlink swap、分页提前停止和取消。
- Workspace RPC：11 项通过，覆盖冷 Session、`ro/rw` 读取、授权前置与完成前复核、目录授权插件卸载、大小限制、版本冲突与过期。
- Client resources：25 项通过，覆盖地址校验、runtime 隔离、取消、pin/release、缓存淘汰与旧代次丢弃。
- 路由与相关消费者：5 个测试文件共 112 项通过；之后新增的连接错误分类测试需继续复跑。
- Gateway：3 个测试文件共 53 项通过，包含已建立 WebSocket 的注销关闭及在途 HTTP 的中止。该组使用 SQLite 测试服务与真实代理，不是 PostgreSQL 双用户资源验收。
- 尚无本轮内存、远程传输、React commit 性能测量，也尚无 Windows、macOS x64、E2B 实机与生产回滚证据。Web 回放已覆盖统计、历史分页、消息操作、反馈布局、模型配置、重试、队列和回放链路；其余场景的 golden 仍需刷新。

- 新增的紧凑流 usage/首 token 读取、同一步重试累计，以及 V41 图片计价的定向测试已通过；真实提供方缓存和图片 usage、跨平台运行与生产回滚仍未验证。

当前未升版本、未提交、未推送。累积审查范围包含 580 个非合并上游提交，其中 alpha.1→rc.2 有 200 个；数量仅用于检查库存完整性。新矩阵仍需补齐逐项源代码审查，不得标为全部对齐。
