# CoHarness → dsh-v0.1.6-alpha.2 升级计划

## 状态、目标与证据

状态：升级终点调整为 alpha.2；alpha.1 Phase 1、2 的实现和历史验收保留，alpha.2 增量尚未实施或验收。不先完成一轮 alpha.1 发布再启动第二轮升级，不整体覆盖上游树，不因目标改变默认开放所有新能力。Q1–Q4 与 1B 启动审计方案已于 2026-09-18 全部确认（见下表），暂无待澄清产品决定。

| 引用 | 固定值 | 用途 |
| --- | --- | --- |
| 已登记同步基线 | `dsh-v0.1.5-rc.2` / `fb2c4b9e698e30edb738bca4cf0618587db7d203` | 累计差异起点，完成前不得前移 |
| 前一实施目标 | `dsh-v0.1.6-alpha.1` / `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d` | 保存已经实施的范围和验收历史，不是本地提交 |
| 本轮唯一目标 | `dsh-v0.1.6-alpha.2` / `ddefc45fbc7f8e46dd73185e68295696d1297887` | 未实施部分直接采用此树的最终实现 |
| 本地规划检查点 | `6f0ec56328048a1f69f179ebbacb2acd0d40e8b9` | 不是上游共同祖先，也不表示已与 alpha.2 等价 |
| 发布版本 | 暂拟 `0.1.6-alpha.2.coharness.1` | release families 和原生产版本核验后确定，本批不改包版本 |

[旧计划](UPGRADE-PLAN-dsh-v0.1.6-alpha.1.md)及[旧审计](../alignment/UPSTREAM-AUDIT-dsh-v0.1.6-alpha.1.md)保存 alpha.1 的实施过程；本计划是后续执行入口。[清单](../manifests/UPGRADE-MANIFEST-dsh-v0.1.6-alpha.2.json)记录决定、阶段与未决项，[矩阵](../alignment/UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.1.6-alpha.2.json)同时记录累计差异和 alpha.1→alpha.2 增量，[本轮审计](../alignment/UPSTREAM-AUDIT-dsh-v0.1.6-alpha.2.md)记录范围来源及证据限制。[同步基线](../../scripts/upstream-sync.json)保持不变。

Phase 1 收口提交为 `6bd418cba3`，原生加载器依赖批次为 `94ea1e1dd8`；Phase 2 收口提交为 `49a968bc26`，较早生命周期迁移见旧审计。`cfb1949958` 合并远端 Web 工作，`6f0ec56328` 后续修改 app-boot 注释、测试及 vendor 记录。旧检查只能证明对应提交和环境；必须记录 alpha.2 实现提交及新验证，不能复制旧退出码作为新目标通过证据。

## 范围和变更纪律

产品仍面向通过 LAN 或公网访问的多用户团队。主机自动化作用于部署节点，不控制访问者电脑；Web iframe 与主机 browser-use 是不同能力。个人、项目、子 Agent、PTC 及直接 Remote 调用都服从同一身份、目录和能力授权。入站隧道、浏览器访问、模型请求、Files 请求及日志上传分别配置和审计，不把 loopback 当作身份凭证。

继承 alpha.1 所有已批准的产品决定（含 webhook 默认关闭）、二开保留要求、数据恢复约束和过程约束；新增能力的具体开放策略以本计划的已确认和待确认项为准。后续 tag 不自动跟进：必要修复以固定 SHA 单列范围，其余变更另行批准。每个实施批次记录上游范围、本地适配、消费者、负例、组装快照、验证提交和未验证环境；已删除的上游包在等价替代与部署依赖核验前不得删除。上游 `apps/desktop` 与 `apps/desktop-host` 桌面客户端不携带（2026-09-18 确认，矩阵 reject 行）；`apps/cli` 归 1B，`apps/web` 归 7A。

本升级处于开发阶段、无生产数据，允许破坏性更新：目标是把上游代码尽可能全量对齐到 alpha.2，本地差异只保留二开主权面（矩阵 `localSovereignty` 为 `replaced`／`owned` 的区域和 `upstreamOnly` 行中经替代面承接的行为），不为兼容旧行为保留并行实现；行为变化必须在批次记录中写明。本地不携带的上游包仍须逐行审查增量并把应承接的行为移植到替代面（如 `api/session-controller` 的 Session 多实例经 `host/apiproxy` 与 `client/runtime`），"不携带"不等于"不审查"。`localSovereignty` 为 `unmanifested` 的 32 个上游新包在各自阶段决定携带与否并登记主权，同步基线前移时写入 `upstream-sync.json`。

全局管理面：`/admin`（`gateway/admin-ui`）是组织级设置的唯一入口。插件管理（7D）、webhook 端点与开关（7B）、终端用户／项目授权（7B，挂在用户与项目页面）、auto-review 资格（6B）的服务端强制设置落在 `/admin`；模型治理沿用现有 Models 页。上游 Web 插件页等会话内入口只提供个人级补充视图，不作为组织策略面。

过程约束：自 `cfb1949958` 起 `master` 同时包含 Phase 1/2 升级代码与生产修复，当前生产运行 `f92068e800`；Phase 8 验收完成前不得以 `master` 部署生产，生产紧急修复从生产提交另开分支单独发布。Phase 1/2 从未执行 `pnpm run test:coverage`（alpha.1 审计记录 coverage 分片被主动终止），1B、2B 首个实施批次前先对现有 Phase 1/2 源码补跑并收口 per-file 100%，不把缺口带入新代码。`.github`、`scripts`、`lefthook.yml` 的累计门禁变化在 0R 完成后、1B 开工前先比对，新增必需检查登记为前置而不是等到 7E。部署前提——文件描述符上限（原生 watcher `EMFILE`）、CPython ≥3.10、平台能力逐项实测——进入 Phase 8 证据列并写入部署文档。

## 已确认的产品策略

| 编号 | 能力 | 决定与不可放宽的条件 |
| --- | --- | --- |
| D1 | 插件管理 | 仅管理员可用，包含 Web、工具及直接 Remote 的安装、卸载、启停和配置操作。普通用户的 Full access 或单次审批不授予 profile 管理权限。治理与隔离插件不得被此入口关闭或替换以绕过强制策略；修改影响整个 profile，必须明确受影响实例和会话 |
| D2 | 用户终端 | 按用户／项目单独授权，默认禁用。运行实例的系统账号权限不等于登录用户权限；准入及重连、写入、调整尺寸、关闭、保留等操作需核验身份和资源所有权。OS／容器隔离与目录政策不得因 Agent sandbox 模式变化而失效 |
| D3 | 模型与计量 | 引入 Messages 和 Files，不自动修改已有 BYOK／组织代理端点；双协议经过模型授权、凭据来源归因和用量记录。默认模型移除只影响默认目录，不删除用户配置；现有配额为提示性政策，不借升级擅改为硬拒绝 |
| D4 | 日志外发 | Session 日志上传默认关闭，显式启用、端点政策及紧急关闭独立于 OTel |
| D5 | 自动化浏览器与桌面 | browser-use 默认独立启动、不附着日常浏览器；computer-use 正式纳入，个人授权后可用，共享项目默认未授权，管理员可开启；执行端必须先落实桌面独占、撤权及清理，不能先上线占用灯 |
| D6 | auto-review 与 SSH | auto-review 仅管理员赋予资格后由当前会话选择，默认不选中，不能扩张组织／项目权限或绕过桌面占用，审查调用计量；SSH 贯穿用户／项目授权与凭据引用，不默认授予远程主机访问 |
| D7 | 交付物与文件变更 | 采纳 `deliverables/tool-present`（自 `fs/tool-present` 迁移）与 `deliverables/workspace-changes`，撤销 rc.2 基线对 produced-files 流程的推迟（2026-09-18 确认）。`workspace/changes` 是上游新增且未标 `ignorable` 的必读 Session 事件，2B 核验其语义后决定本地是否保持必读，同步基线前移时同步更新 `upstream-sync.json` 的 upstreamOnly 记录；变更卡片与逐文件审阅经 workspaceFiles 授权、项目 ACL 和只读成员规则，不暴露未授权路径 |

插件安装加载的是运行实例内代码，不是 workspace sandbox 内普通操作。registry 来源、版本锁定、依赖构建脚本审批、取消和失败后的持久状态必须审计；无需回滚的上游 Loader 语义不能被误写成安装失败必然恢复旧树。

终端取消授权后不得继续写入或创建；退出、撤权与管理员停止须等待执行端清理。浏览器刷新恢复的是仍存活的进程连接，不等于 Host 重启后恢复进程。终端成员准入与跨成员查看规则仍需 Q2 明确，不能只凭 Session id 获得控制权。

## 阶段、依赖与放行条件

1A、2A 仅表示对 alpha.1 的历史完成。以下其他阶段初始均为待实施；0R 是本批记录重规划，不代表累计源码审查已经结束。责任域是技术归属，不是假定已有人员排期；各批启动前指定负责人及复核人。

| 阶段 | 前置 | 责任域与可独立提交的范围 | 本阶段必须提供的证据 |
| --- | --- | --- | --- |
| 0R | 无 | 规划／发布：固定引用、累计与增量库存、已完成继承、Q1–Q4、验证环境、`.github`／`scripts`／`lefthook.yml` 门禁差异比对 | 矩阵路径与 `git diff --name-status --no-renames` 逐文件对账一致，无重复或丢失行；每项有阶段／责任域；新增必需检查已登记；结构检查通过不等于语义审查通过 |
| 1B | 0R 范围确认；Phase 1/2 源码 coverage 收口 | boot／Typert／vendor：dsh-hmr、共享重载队列、runtime resolution、profile-context、诊断、安装与卸载基础；`apps/cli` profile-boot（`resolutionMode: 'runtime'` 默认、`dsh <profile>`）。承接 alpha.1 Phase 1：`app-boot/src/watch-config.ts` 及其测试迁至 `boot/hmr`；本地 `assertEntriesLoaded`／`assertEntriesActivated` 对齐上游结构化 `inactiveEntries` 与启动诊断日志；重放 vendor 两处 alpha.2 修改（`loader/config/entry.ts` fiber 身份取 `.ctx.fiber`、`cordis/logger.ts` exporter 释放按注册 id）；更新对应 Agent Note 与 `vendor/README.md` 第 9 条路径 | 模块／配置连续变更、初始缺目录、并发重载、启动失败及卸载测试；CLI/Web 真实 Loader 快照；source 与 packaged profile／worker 解析，不将 required-startup 留成无归属任务；`EMFILE` 在迁移后的 watcher 上复测 |
| 2B | 1B 涉及的初始化接口稳定；Phase 1/2 源码 coverage 收口 | Agent／Session／subagent：Inbox 冷恢复（投影注册位置按 alpha.2 复核后决定移植方式）、继续对话、默认最多 8 个存活子代理和深度 1 的配置迁移、D7 的 `workspace/changes` 必读事件语义、Session 写锁被其他实例占用时的提示 | 未激活 Agent 的 pending Inbox 恢复、取消／失败／父属测试；保留本地 inbox 配额与协作权限；TS/Python SDK 和真实组装输出，检查新必读事件但不凭版本号提升格式 |
| 3A | 2B | LLM／Gateway 治理：双协议、地址拼接、历史工具输入序列化、pi-ai modalities、默认目录 | 双协议 keyless 快照及真实 provider；旧代理配置不变、无权模型拒绝、凭据与计量正确；配置过渡兼容明确 |
| 3B | 3A、Session 投影 | attachment／compaction／持久化：Files、图片编码与计价、offload、冷恢复 | 大小／数量限制，上传取消／失败；旧 Session 重放、引用完整性、不可变代次；带图片真实请求和缓存用量，SDK／Web 图片转录 |
| 4A | 1B、2B | PTC／workflow：新运行时与所有消费者迁移 | 原生/PTC 工具同一授权，绑定与协议错误、取消／超时、worker/subprocess 静止；相关组装快照 |
| 4B | 4A | shell／subprocess／sandbox／jobs：资源回收、Windows 无闪窗、SSH 所需适配、旧包去留 | 目录拒绝、撤权、进程树终止和重启；Linux/macOS/Windows 实测；E2B 替代证明后才能删除，缺环境记阻塞 |
| 5 | 2B、4B；设计可提前 | Gateway／执行节点：桌面资源协调、runtime 认证和准入 | 双运行时争用、旧代次拒绝、FIFO/去重/取消、撤权、失联、崩溃、协调者重启和停止失败；模型可见结果入日志 |
| 6A | 3B、4B、5 对桌面路径放行 | browser-use／computer-use providers | 独立浏览器资源生命周期、附着授权、截图可见性、外部监听／下载；桌面驱动与系统权限（验收设备按 Q4 确认项在 Phase 5 设计时单列）；无 GUI 节点其他能力仍可用 |
| 6B | 5、6A、7A | 权限／Web：占用与队列 UI、auto-review、当前有效权限模式不重复审批 | LAN/公网真实双用户流程，撤权和 PTC 内层调用不可绕过；隐私、减少动画、未知状态；审查失败关闭及用量归因 |
| 7A | 1B、2B | client／Gateway：Session 多实例与 slot、Workbench、子会话和计划侧栏、`apps/web` 组装测试；`ui-conversation` 上下文用量移至输入框底部与拖拽区域修复先与本地 composer 修复（#215–#217）逐规则对照再迁移；`api/session-controller`（38 个增量文件）、`api/gateway`、`client/store`／`resources`／`ui-chat`／`ui-session`／`ui-approval`／`ui-sidebar-right` 为不携带包的参考实现，多实例、slot 与 inbox 镜像行为经 `host/apiproxy` 与 `client/runtime` 移植 | pane、Session、runtime 显式对应；切换／关闭／恢复不误发请求；项目 ACL、归档过滤、历史地址；Web 多实例快照及 Android/API 消费者；composer 窄分栏回归不复现 |
| 7B | 4B、7A | terminal／SSH／MCP／webhook：终端授权、retain/重连/关闭、MCP resources、webhook 与 webhook-github 入站端点 | 默认禁用、Q2 双门（用户且项目）授权矩阵、只读成员完全不可用、创建者私有、管理员仅列与关；撤权清理、刷新不重生 shell；SSH 凭据与路径授权；webhook 默认关闭、管理员显式启用、签名校验、重放与限流、Session 创建归属；LAN/公网场景 |
| 7C | 3B、7A | files／deliverables／Office／preview：D7 交付物（tool-present、workspace-changes 变更卡片与逐文件审阅）、Office、侧栏 URL；`ui-sidebar-documentpreview`（58 个增量文件）与 `api/workspace-files` 为不携带包的参考实现，预览与授权行为移植到 Workbench 文档面与 `host/apiproxy` | workspaceFiles 授权及版本校验、缓存隔离／撤权、并发修改不误归因；Office 原生 macOS arm64 与 Linux WASM 实测（含缺字体、取消、资源限制与平台产物）；Browser 载体、URL 和 sandbox 政策；授权负例及快照 |
| 7D | 1B、7A | plugin-manager／Creator／Gateway 管理；Creator 移除 `tool-cordis` 动态定义与运行工具后的 api-catalog 与 ui-cordis 调整 | D1 服务端强制执行，普通用户直接 RPC/工具均拒绝；强制治理插件保护；管理员操作审计、安装取消／失败、重载和卸载；Q1 四来源与构建脚本批准路径按确认项实现；持久化 profile 与 source/built 启动 |
| 7E | 按矩阵逐项前置 | 各包责任域：其余累计差异、工作区分组、菜单键盘、轨迹附件、思考内容紧凑排版、性能与非 packages 文件（门禁差异已在 0R 处理） | 每行闭环源码／消费者／决定；保留 User Documents、Workbench、归档、协作及 SDK；新增、删除、替代逐项销账，不能以“其他”整体放行 |
| 8 | 所有拟发布项完成；Q1–Q4 已决定或入口明确禁用 | 发布／数据／运维：迁移、产物、平台与生产 | published paths/hygiene/built smoke、必需 CI 和明确 skip；部署前提清单核验；合成数据迁移演练（Session 代次链、SQLite schema、未来格式拒绝）；双用户验收、版本闭包及健康证据；解除 `master` 部署冻结。无生产数据，不做脱敏副本恢复与停机窗口 |

关键路径为 0R→1B/2B→协议及执行迁移→所依赖的新入口→8。7A 在接口稳定后可与 3/4 并行；5 的设计与测试环境准备立即开展，但不能在执行端未落实时开放桌面操作。每个任务只执行其相关检查，已通过且输入未改变的检查不因提交／推送机械重跑；vendor 同步仍按 vendoring 特殊要求执行。

## 桌面与多实例必须保留的语义

桌面按执行节点及交互桌面标识协调；provider 注册排他不等于跨运行时独占。个人、项目、子 Agent 与 PTC 共用执行端准入，租约不能充当人工审批。连续任务期间不按点击交错发放；FIFO、重复去重、不自动抢占，时限与队列容量为部署配置。客户端不能自报可信持有人。失联／超时先进入停止或待确认；确认旧动作结束才释放，无法确认则不可用；协调者重启不能只清空记录后重新发放。停止不撤销已送达输入，产品租约不约束宿主人工作业；部署需专用桌面及紧急停止。

UI 区分空闲、自己／他人占用、排队、停止中、不可用、待确认和未授权；只显示获准的身份信息，不暴露他人任务、标题或截图，遵守无障碍及减少动画。模型可见的队列与拒绝必须入 Session 日志。客户端 pane 的 active 状态不是权限来源；每次操作绑定 Session 与 runtime，恢复布局重新检查可见性，关闭 pane 不终止 Session；终端和预览不得复用错误实例的连接。

## 已确认的策略（2026-09-18）

| 编号 | 已决事项 | 决定与不可放宽的条件 |
| --- | --- | --- |
| Q1 | 插件安装来源与构建脚本 | 管理员可用上游全部四种来源（registry、绝对路径、git、tarball）；依赖构建脚本沿用上游批准模型——pnpm 阻断的脚本经 Web 插件页「允许并重试」或工具侧 `approvedBuilds` 批准，按包名持久化；批准动作归管理员审计。安装入口仍由 D1 服务端强制仅管理员 |
| Q2 | 用户终端授权组合 | 双门：管理员分别为用户和项目开启，两者都开才能创建终端；终端归创建者私有，其他项目成员不可见；管理员可列出与关闭但不接管输入；只读成员完全不可用；不以 Session 可见性授予终端控制权 |
| Q3 | 侧栏 Browser | 本次开放，行为与上游一致：iframe 载体，允许 loopback，每 tab 可临时关闭沙箱（不持久、带警告），拒绝 DSH 自身 origin；地址栏对 loopback 目标提示「localhost 指你自己的电脑」，不承诺部署主机 localhost 直达 |
| Q4 | Office 平台与验收 | 首发声明 macOS arm64（原生引擎）与 Linux（WASM）两个平台；Windows 不宣称；需要准备一台 Linux WASM 验收环境（容器可），缺该环境则 Linux 标 unverified；浏览器／桌面驱动验收设备与 staging/生产窗口在 Phase 5 设计定稿时单列 |

## 1B 启动审计方案（2026-09-18 确认）

`1B` 采用上游 `inactiveEntries` 结构化实现（`failed{error,phase}`／`pending{missing}`）与启动错误分类、诊断日志文件，整体替换本地 `assertEntriesLoaded`／`assertEntriesActivated`；本地 `disabled` 表达式包装诊断与两条守卫测试在上游结构上重写；Agent Note《Consumers audit activation instead of catching transactional rollback》改写为描述上游机制，`vendor/README.md` 第 9 条路径同步更新。

允许明确延期新入口，但需用户批准并更新计划与清单；不能静默削减原批准范围。Phase 8 汇总的是前序实际验证，不是第一次准备 API Key、GUI 权限、双用户环境或备份副本。

## 数据、二开保护与证据要求

持续验证登录、身份、项目 ACL、只读成员、目录授权，模型策略/BYOK/提示性配额/用量归属，协作/私有性/父属/inbox 配额，User Documents/Workbench/资源预览，以及 Android、TS/Python SDK、推送、LAN/公网和 PostgreSQL/Linux/macOS 部署。树外治理插件和 Gateway 的独立测试不由根单测替代。

迁移前盘点 Session 代次、未知必读事件、SQLite schema、PostgreSQL ledger、附件及归档引用；仅结构变化增加相邻 Session 格式迁移。JSONL 新代次发布不移动、覆盖或删除已提交代次；SQLite 版本单调，PostgreSQL 编号按实际 ledger 续排。本阶段无生产数据，允许重置环境直接迁移；迁移机制本身仍按发布质量验证——在合成数据上验证迁移重跑、中断、损坏及未来格式拒绝，对比对象数量、引用和摘要，保证机制对将来真实数据正确。代码回退不等于数据可降级；新事件是否 ignorable 由语义决定；开发环境允许整体重建，不要求备份窗口。

验收记录需要本地 commit、上游范围、命令、退出码、环境和覆盖能力；unit、keyless snapshot、真实 provider、built artifact、平台与生产分别记录。SDK 输出变化同时覆盖两种 SDK；GUI/终端/插件管理需真实组装，mock 不替代。外部凭据或权限缺失记 unverified/blocked，skip 不计通过；CI 必需任务未执行时不能只凭汇总绿灯放行。alpha.1 遗留的未验证项、环境阻塞、不稳定用例和观察项集中在[本轮审计的台账](../alignment/UPSTREAM-AUDIT-dsh-v0.1.6-alpha.2.md#未验证与环境阻塞台账)，共 23 项，每项已绑定承接阶段；新增欠账追加到该台账，不另建清单，销账时记录验证提交与命令。

## 排期方法与完成定义

既有人日和完成率只作为低置信度参考，不按 887 个提交、2,643 个变化文件或矩阵行数线性折算。0R 完成后，各阶段按可验收批次估算实现、测试、文档、设备／凭据等待与集成缓冲，明确负责人、前置和最早验收时间；目标变更后的总量不得沿用 alpha.1 分母。

完成本次升级须所有矩阵行有目标版本审查结果及消费者证据，已批准范围实现或经用户批准延期，未决策略解决，发布产物／数据恢复／必需平台与生产检查通过，再决定发布版本并推进同步基线。仅目标文档更新、本地单测绿或部分包同树都不满足此定义。
