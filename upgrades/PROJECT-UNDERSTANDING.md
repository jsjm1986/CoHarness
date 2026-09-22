# CoHarness 全项目理解报告

> 生成时间：2026-09-18 ｜ 分支 `master` ｜ HEAD `03668e6d6d`
> 视角：业务逻辑 + 设计理念 + 用户视角
> 方法：5 路子代理分域通读（架构/Gateway/用户/自有资产/治理），主代理复核关键事实

---

## 0. 一句话定位

**CoHarness = 上游 DeepSeek Harness 的「全插件化 Agent 运行时」+ 我们自研的「面向认证团队的产品控制面」。**

它不是换皮：上游负责"Agent 怎么跑"，我们负责"一群人如何共用、共治、共担责任地让 Agent 跑"。用户看到的品牌是 CoHarness，运行时包名/插件 id/配置词汇刻意保留 `dsh`，目的只有一个——**让上游适配可持续**。

这条定位在 README.zh.md:7 与 :9 里写得很直白：

> CoHarness 把协同看作团队共同构建的方式，而不是团队被动使用的功能。
> CoHarness 是独立维护的衍生项目，不是把上游版本重新命名后发布。

---

## 1. 分层地图：谁负责什么

| 层 | 目录 | 归属 | 职责 |
|---|---|---|---|
| 运行时内核 | `packages/` | 上游为主（adapted 230） | Cordis 插件框架 + 能力包；core spine = session / system-prompt / tools / agent / agent-loop / scope |
| 插件框架本体 | `vendor/` | 上游 vendored Cordis（9 包 rescope） | "一切皆插件"的运行时地基，有本地改动须穷举维护 |
| **产品控制面** | `gateway/` | **纯自研** | PostgreSQL 17 认证、用户/项目/权限、模型治理、用量、审计、Admin SPA |
| **实例内策略** | `plugins/` | **纯自研（树外）** | `dsh-directory-guard`、`dsh-model-governance` |
| 端 | `apps/` | cli 上游归 1B / web 自研改造 / android-shell 自研 | `dsh` 启动器、浏览器工作空间、Capacitor 壳 |
| 隔离 | `native/` | 自研 Landlock 启动器 | 内核级目录隔离 |
| SDK | `python/` | 自研 | Python SDK + bundled runtime |
| **治理产物** | `upgrades/` | **自研机制** | 按 release 保存的上游计划/manifest/对齐矩阵 |
| 决策记录 | `.agents/notes/` | 自研 | 1932 篇 Agent Note（ADR） |
| 工程记录 | `engineering/` | 自研 | 质量审查、性能基线、插件安全计划 |
| 复盘 | `docs/postmortem/` | 自研 | 4 篇事故复盘 |

**关键判断**：这个项目的"自有业务逻辑"几乎全部集中在**控制面（gateway/）+ 实例内策略（plugins/）+ 主权包（29 owned）** 这三处。运行时内核是继承来的，不是我们造的。

---

## 2. 设计理念（架构层）

### 2.1 「一切皆插件」不是口号，是没有特权内核

`packages/` 里没有"核心调度器"这种超级模块。连 CLI 里看起来像编排器的东西都只是语法糖。`apps/cli/src/lib/app.ts:91-107` 的证据很硬：

```ts
// 注释明写：此处不进行插件调度，仅是 conductor 语法糖；
// 唯一特权是 CLI 作为根 context 持有者
```

三个核心能力(ModelServer / ToolServer / PluginManager)都是普通 Cordis Service——**它们之间不知道彼此存在**。组合发生在 cordis.yml 里，不在代码里。

实践推论：给系统加功能，是"写一个插件并声明它"，不是"找地方插 if 分支"。

### 2.2 capability seam：三角色解耦

每个能力面(llm / fs / shell / web / subagent / compaction…)切成三份：

- **Definition**：契约 + 事件类型 + 元数据 schema，**零实现**
- **Provider**：具体后端（本地 fs / E2B 沙箱 / pwsh）
- **Consumer**：把能力暴露给模型的工具

铁律：**扩展插件只依赖 Definition，不依赖具体 Provider**。所以换后端不动工具，换工具不动后端。这是本项目能在"吸收上游改进"与"保护自有逻辑"之间长期共存的结构性前提。

### 2.3 model-visible means logged（本项目最硬的一条原则）

凡是进入模型请求的内容，必须能从 session 日志完整重建。

实现上不是靠自觉，是靠**类型系统强制**：
- `ModelServer.ensureRequestSnapshot()` 是唯一入口
- context 组装只接受 snapshot 句柄，不接受活对象
- 因此"拼了一段没记录的 prompt"在类型层面就过不去

为什么这么重要：session 是**事件溯源**的（append-only JSONL，不可变代次）。日志既是审计凭据，也是恢复/分叉/复盘的唯一起点。一旦有内容绕过日志，整个"可恢复、可复盘、可问责"的产品承诺就塌了。

### 2.4 事件三域

| 域 | 典型前缀 | 持久化 | 用途 |
|---|---|---|---|
| Session | `session/*` | **是**（进 JSONL） | 对话历史、工具结果、审批决策 |
| Agent | `agent/*` | 否（活体） | 生命周期信号、内部协调 |
| Capability | `fs/*` 等 | 否 | 策略拦截、授权判定 |

区分依据只有一个：**是否需要跨进程/跨时间重建**。需要重建的进持久域，否则留在活体域。DB 文件不进持久流——session-jsonl 的 `fileMetadata.generation` 显式排除它，因为它是可变容器，重放会污染快照。

### 2.5 注册即 effect

```ts
const dispose = registry.register(...)   // 返回 disposer
ctx.effect(() => { ...; return () => cleanup() })
ctx.on('event', handler)                 // 自动随 scope 回收
```

没有"注销函数"这个独立概念——注册行为本身就是 effect。推论：**任何贡献都必须可回收**，热重载、profile 切换、插件卸载才可能正确。

### 2.6 运行时不变量：断言「拥有关系」，不断言「存在」

`packages/AGENTS.md` 的规则很特别：

> Runtime invariants assert owned relationships. Check authoritative event streams or mutable data, **not** service or method presence, plugin metadata or effects, or fixed pure examples. Without a plausible relationship, an explained empty companion is correct.

翻译成人话：**不要写"这个服务存在吗"这种断言**（那是元数据检查，永远是绿灯，毫无价值）。要断言的是"这个插件声明拥有 3 个 tool，那么权威事件流里就该有 3 个 tool"——**建立关系，并验证关系成立**。如果一个插件确实不产出任何东西，那么"一个被解释清楚的空的 companion"就是正确答案，不是缺陷。

配套还有一个反模式禁令：**不要用 assert 去兜底 reconciliation**。服务注册与权威流之间若不一致，应该 reconcile（对齐），而不是加一条断言把不一致合法化。

### 2.7 防御性默认值：元数据驱动 + 幂等声明

我们自己的代码风格与上游有一处明显分歧：

- 上游 `addModel()` 重复注册会**抛错**
- 我们的 `declareModelProvider / declareModelCatalogEntry / upsertCredential` 是**幂等 upsert**

理由：模型 Provider 配置来自多个来源（用户配置 / 组织下发 / 插件声明），且会热重载。**抛错会让"重复声明"变成启动失败**，这在多来源场景下是脆弱设计。幂等 upsert 让"谁最后声明谁生效"成为可推理的规则。

同理，能力表达用**描述性元数据**而非枚举：`supports reasoning / vision / tools / streaming` + `contextLimit`。新增能力是加字段，不是改判断分支。

### 2.8 兼容性纪律

- Session JSONL：**不可变代次**。新代次发布不移动/覆盖/删除已提交代次；前代不隐含降级或回退支持。
- SQLite：`SCHEMA_VERSION` 单调。
- PostgreSQL：migration 由 Gateway 启动 runner 应用，编号按实际 ledger 续排。
- 刻意保留上游词汇（npm scope、插件 id、`cordis.patch.yml`、`DSH_HOME`）——**这是"可持续对齐"的代价，也是它的前提**。

---

## 3. 我们的业务逻辑（重点）

### 3.1 主权边界：机器可读的清单

`scripts/upstream-sync.json` 是本项目最独特的资产——它把"哪些是我们的"写成了可执行的事实（字段名是 `sovereignty`，不是 `status`）：

```
syncedTag: dsh-v0.1.5-rc.2  (fb2c4b9e)
packages: 264 条
  adapted 230   —— 上游为主，本地有改造
  owned     29   —— 纯自研，升级时不得被上游覆盖
  replaced   2   —— api/gateway、session/session-persistence（整条替换）
  tracked    3   —— compaction/compaction、jobs/jobs、workflow/workflow（严格跟随）
upstreamOnly: 32 —— 上游有我们不携带，多数标注了 replacedBy
```

**29 个 owned 包**（这就是"我们的业务逻辑"在代码层的完整清单）：

| 域 | 包 |
|---|---|
| Gateway 接入 | `host/apiproxy`、`host/userdoc-http`、`session/session-persistence-gateway`、`session/session-persistence-sqlite`、`context/gateway-runtime`、`context/archive-gateway` |
| 协作 | `context/collaboration`、`context/collaboration-context`、`context/collaboration-gateway`、`client/ui-collaboration` |
| 用户文档 | `attachment/userdoc`、`attachment/userdoc-local`、`attachment/tool-userdoc`、`client/userdoc-upload`、`client/ui-documents`、`context/userdoc-context` |
| 模型治理 | `llm/model-access`、`llm/model-provider-config` |
| 运行时管理 | `boot/hmr`、`boot/plugin-manager`、`client/runtime` |
| UI 自有面板 | `client/ui-workbench`、`client/ui-usage-alert` |
| 其他 | `mcp/mcp-resources`、`util/lazy-require`、`test-support/acp-snapshot`、`examples/{acp,agent-spine,jsonrpc}-demo` |

### 3.2 Gateway：认证团队的控制面（纯自研，最完整的业务实现）

**定位**：把"协同哲学"落实为**经过认证的项目边界**。单机 DSH 没有"人"的概念，Gateway 补上这一层。

**领域模型**（PostgreSQL 17，`gateway/src/db/schema.ts`，`SCHEMA_VERSION = 6`）：

```
orgs（组织，可选）
  └─ users ── user_sessions ── web_sessions
  └─ projects ── project_members ── project_invites
model_providers ── model_catalog_entries
provider_credentials（仅存引用，不存密钥明文）
usage_ledger（用量账本）
```

**角色**：`owner / admin / member / viewer / billing` 五类
**权限判定**：`hasProjectAccess(req, projectId, 'reader' | 'writer')`
**项目 scope**：`personal:<userId>` 与 `project:<projectId>` 两种

**四条核心业务闭环**：

1. **认证会话**：登录 → HttpOnly cookie（30 天 / 12h 滑动续期）→ 每请求校验 session → 跨服务传播 principal
2. **多用户项目协作**：建项目 → 邀请（`project_invites`）→ 成为成员（role + `ro`/`rw`）→ 共享一个 runtime 实例与持久化存储；**成员不会各自得到同一对话的互不相连副本**；根对话可见性（项目可见 / 仅创建者可见）被子对话继承
3. **模型治理三态闭环**（`llm/model-access` + `plugins/dsh-model-governance`）：
   `registration`（登记 Provider）→ `policy`（按角色/用户/项目授权）→ `access`（运行时准入）
   —— 登记**不等于**授权，README.zh.md:119 明确写了"Gateway 只向管理员记录不含秘密的登记活动，不会把登记历史当成审批名单"
4. **用量与审计**：`usage_ledger` **只存整数单位与元数据，不存 API 密钥、提示词或回复**（README.zh.md:67 "在不把 API 密钥、提示词或回复写入账本的情况下归属活动"）

**多实例调度**（`gateway/src/instances/scheduler.ts`）：FIFO 队列 + 请求去重 + 30s 心跳租约 + 主动撤销 + 陈旧实例清理。**租约不能充当人工审批**——这是有意的设计边界。

**成熟度判断（有证据）**：
- ✅ 服务端强制层相当完整：principal 传播、ACL、凭据隔离、用量账本、调度生命周期都有真实实现
- ⚠️ **Admin SPA 是骨架**：只有 `models` 与 `instances` 两个视图，尚未覆盖用户/项目/审计/用量等管理能力
- ⚠️ **实例注册表是内存态**：进程重启即失，多实例部署会漂移（无外部协调）

### 3.3 两个实例内策略插件（树外，纯自研）

这两个插件不放在 `packages/` 里，是刻意的——它们是**治理策略**，与运行时内核解耦，可独立版本化。

#### `plugins/dsh-directory-guard` — 目录强制

- **机制**：监听 `fs/authorize` 事件，事件携带 `{ path, resolution }` 并**声明 `granted: false`**，插件按需置 true
- **覆盖面**：`PRESENT_FILE_TOOLS` 共 **88 个** 具名工具——不是只挡读写，**连 `view_file`、`list_directory` 这类"存在性探测"也挡**
- **三态授权**：`pending`（待批准）/ `implicit`（自动授权，来自 policy 规则）/ `explicit`（用户已批准）
- **纵深防御**：即便未配置，也强制"必须在 workspace root 内"，杜绝任意路径逃逸
- **风格**：幂等 upsert（grant 声明不抛冲突）

#### `plugins/dsh-model-governance` — 模型治理

- **原则：决策下沉，执行上浮**
  - 拦截 `model/declare`（决定模型能否出现）
  - 拦截 `config:model-provider`（下发 Provider 配置）
  - 拦截 `credentials:resolve`（接管凭据解析）
- **三种模式**：
  - `byok` —— 个人自带密钥，**不受组织治理**（边界清晰：个人自费自担）
  - `org` —— 组织下发 Provider + 配额
  - `project` —— 项目级策略覆盖
- **闭环**：`outbox.ts` 把用量事件回传 Gateway，让治理不只看配置、还看实际消耗

### 3.4 其他自有业务逻辑

| 项 | 位置 | 业务意图 |
|---|---|---|
| 用户文档协作 | `client/ui-documents`、`attachment/userdoc-*` | 命名文档、上传下载、加入对话、跨 scope 复制、快照谱系、冲突安全命名；**文件字节仍存于 runtime 拥有的目录**，PostgreSQL 只存元数据对账 |
| Workbench | `client/ui-workbench` | 侧栏面板 + pane 级 markdown 表格（#213） |
| 用量告警 | `client/ui-usage-alert` | 终端用户侧的配额提示（现为**提示性政策**，不硬拒绝） |
| Landlock 启动器 | `native/` | 内核级目录隔离；Linux 强于 macOS |
| Python SDK | `python/` | 非 Node 生态接入 |
| Android 壳 | `apps/android-shell/` | 移动访问 + FCM/JPush/厂商推送 |
| HMR / 插件管理 | `boot/hmr`、`boot/plugin-manager` | 热重载与运行时插件生命周期 |

### 3.5 与上游的边界：风险分级

| 类型 | 例子 | 升级风险 |
|---|---|---|
| **在上游机制内扩展**（低） | 两个树外策略插件、owned 包 | 低——插件契约未变即可存活 |
| **绕开/替换上游机制**（高） | `api/gateway`、`session/session-persistence`（replaced）、32 个 `upstreamOnly` | **高——上游若改动被替换面的事件契约，替代面必须同步** |
| **刻意保留的上游词汇**（中） | `tool/code-dispatch*`、`code` preset | 中——是持久化事件类型名，改名会导致跨版本日志不可读 |

---

## 4. 用户视角

### 4.1 四类用户（README.zh.md:30-35）

| 用户 | 需要什么 | 是否依赖 Gateway |
|---|---|---|
| **个人用户** | 一台机器上的持久化工作方式 | 否 |
| **团队成员 / 项目负责人** | 参与共享项目、接手进行中任务、检查 Agent 活动、处理待决策事项 | 是 |
| **组织管理员** | 建立项目/成员/模型/用量/运行时规则，让协同可问责 | 是 |
| **集成开发者** | 通过插件/SDK/JSON-RPC/ACP/新 Provider 扩展同一套协同模型 | 可选 |

### 4.2 三种运行方式（README.zh.md:39-45）

| 场景 | 方式 | 能力 |
|---|---|---|
| 一台电脑试用 | 本地 `dsh web` | 本地文件 + 本地 Session；**不需要 Gateway 或 PostgreSQL** |
| 可重复自动化 | Headless / JSON-RPC / ACP / SDK | 非交互 Session、事件流、脚本集成 |
| 团队认证访问 | Gateway + Web runtime | 用户、个人空间、共享项目、权限、模型治理、用量、审计 |
| 强化 Linux 隔离 | systemd 部署 Gateway | 每 runtime 独立账户、mount namespace、内核级项目隔离 |
| 移动访问 | Web UI 或 Android 壳 | 浏览器或 Capacitor 客户端 |

**一个重要的产品判断**：Gateway 是**可选**的，不是强制的。个人路径完全不碰 PostgreSQL。这降低了个人用户的门槛，也让团队路径的价值更清晰。

### 4.3 用户旅程（最短路径）

```
1. 在含目标文件的目录执行 pnpm dsh web --no-open
2. 打开 http://127.0.0.1:3080
3. 设置 → 模型：配置 DeepSeek 密钥 / 目录 Provider / 自定义路由
4. Web UI 选择工作区目录（全新 UI 不会自动选中，必须先选）
5. 下达任务 → Agent 调查/编辑/整理
6. 文件修改、命令执行等受治理操作触发审批 → 人授权
7. 结果返回 + 完整工具历史落盘
8. 之后回到同一目录可恢复 Session
```

团队路径在步骤 3-4 之间插入：登录 → 进入共享项目 → 目录授权 → 模型授权（组织路由）。

### 4.4 协同哲学（这是产品灵魂，不是营销话术）

README.zh.md:23-28 的六条原则，每条都对应真实实现：

| 原则 | 落点 |
|---|---|
| 协同单位是**共同工作**，不是共享聊天 | 项目保存持续环境 + 参与者贡献 + 委托关系 + 待处理决策 + 可恢复进度 |
| 身份与贡献属于**工作上下文**，不只属于界面 | 参与者归属进共享历史 |
| 委托遵循**明确的关系与限制**，不复制所有权限 | 子 Agent 不静默继承全部能力；内部完整记录不灌入父任务 |
| 信息只流向**真正需要它的人/智能体** | 成员关系 / 对话可见性 / 读写权限三重决定 |
| 人的判断是**一等参与者** | 审批用于授权受控操作；提问用于补充业务判断；**有权限者原子接手待处理决策**（并发响应不产生竞争结果） |
| 每项任务都能**继续、交接、恢复、复盘** | 事件溯源 + 不可变代次 |

### 4.5 能力全景（README.zh.md:73-83 摘要）

- **运行时**：Cordis profile/bundle、事件溯源 Session、恢复/分叉、压缩、telemetry
- **工具**：工作区 FS、图片读取、Shell 与持久终端、LSP、网页搜索/抓取、skill、结构化附件、用户文档
- **模型**：DeepSeek 与 pi-ai 适配器、目录与自定义 Provider、BYOK、组织托管路由、推理控制、图片准入、**凭据引用不写秘密进日志**
- **Web UI**：响应式、实时历史、模型选择、`@` 建议、附件、文档管理、权限控制、目标、subagent、任务、设置、本地化、主题
- **项目**：个人/共享 scope、每项目一 runtime、`ro`/`rw` 成员、邀请、可见性继承、目录授权
- **文档**：上传下载、加入对话、跨 scope 复制、快照谱系、操作历史、冲突安全命名
- **集成**：TS/Python SDK、JSON-RPC、ACP、Codex/Claude hook bridge、可选 Codex/Claude subagent provider、Android + 推送

### 4.6 信任模型与安全边界（用户必须知道的）

SAFETY.zh.md 的措辞异常克制，值得原文引用：

> 处于发布前阶段，尚未接受安全审计。**不要把它视为完整的安全边界**。
> 沙箱、审批、Gateway 认证、项目 ACL 和凭据隔离可以**降低风险，但不能保证隔离**。
> 不要把 CoHarness 作为不可信工作负载唯一的安全控制措施。

关键事实：
- **Linux systemd 提供 mount namespace 边界；macOS 不提供**（README.zh.md:47）——这是部署选型的硬约束
- 出厂基础 Profile **默认启用 `web_fetch`**（仅经验证的公开目的地、无需逐次批准）；网络策略严格的部署应覆盖 `tool-web` 行
- 插件 metadata 与 Session-log upload **默认关闭**
- Gateway 必须在 TLS 之后，不得暴露未认证 runtime 端口
- 本项目"可以执行模型生成的命令与代码、加载第三方插件"——**能力即风险**

### 4.7 体验上的空白（有证据）

- 用户文档**只有 14 篇**（guide/develop），相对能力覆盖面偏薄
- **Admin SPA 是骨架**（仅 2 视图），管理员的多数能力当前要走 API
- **Workbench 有组件、无用户文档**；Web 端到端步骤需靠推断
- Android 壳 `capacitor.config.ts` 有 banner 缺失等配置缺口
- CLI 参考链接指向 `apps/cli/reference/README.zh.md`，**该文件不存在（404）**
- 官方文档入口与实际文件存在系统性错位
- 文档称 `rc.2` 为最新对齐记录（README.zh.md:96），但**升级目标已重定向到 alpha.2**——文档滞后于实际

---

## 5. 工程治理与「我们怎么做事」

### 5.0 团队工程哲学（可验证，非口号）

| # | 原则 | 出处 |
|---|---|---|
| 1 | **一切皆插件，改 loop 是最后手段**：新行为走文档化扩展点；动 `agent-loop` 必须同步 `docs/architecture.md` | AGENTS.md:109, :3 |
| 2 | **Model-visible ⟺ logged**：进模型请求的东西必须能从 Session 日志重建 | AGENTS.md:108 |
| 3 | **source plane 与 artifact plane 永不混用**：测试/静态门禁经 tsconfig paths 解析到 `src`；消费 `lib/` 必须显式声明 | AGENTS.md:117；docs/testing.md:41 |
| 4 | **边界显式 > 隐式**：默认值是 owning 实现里的显式 `resolve(request): Spec`；插件无硬编码 tunable；误配置 loud fail | AGENTS.md:112-114 |
| 5 | **优先维护良好的依赖，反对 hand-roll**；同进程 typed 边界信任 TS，只在 parser/config/queued/model/durable/wire 边界做运行时校验 | AGENTS.md:111,116 |
| 6 | **证据与面匹配，不默认跑全量**：行为→聚焦测试，模型/用户可见输出→快照，发布路径→build/smoke；CI 拥有穷尽覆盖 | AGENTS.md:91-92 |
| 7 | **验证世界，而非自证**：e2e 必须外部重跑/重读；断言未触碰文件字节不变；测试走真实入口与已发布产物 | docs/testing.md:29-37 |
| 8 | **文档一事实一归宿，禁叙述历史**；有字数预算门禁 | docs/AGENTS.md:15-34, 47-57 |
| 9 | **非平凡改动同一 PR 必附至少一篇 Agent Note** | .agents/notes/README.md:46；AGENTS.md:123 |

第 7 条尤其能说明团队性格——"验证世界，而非自证"。复盘 0002 就是这条的由来：Cordis 只对 `entry.options.config` 插值、`disabled` 不插值，而 **snapshot refresh 把确定性转录当成了正确行为**，于是 `!!js` 表达式静默关闭了 FS 工具。落地护栏是两条门禁：`verify-cordis-config` 拒绝 entry metadata 里的表达式节点、`dsh-acp-snapshot` 拒绝 `UNKNOWN_TOOL` 结果（postmortem/0002:36-47）。沉淀出的规矩是：**快照刷新是夹具生产，不是正确性审查；语法合法 ≠ 在该位置被求值**。

### 5.1 三套知识沉淀机制

| 机制 | 位置 | 角色 | 活跃度 |
|---|---|---|---|
| **ADR（Agent Note）** | `.agents/notes/`（implemented/archived/proposed/rejected 四态） | 记录"为什么这么改" | **极高——966 篇**（implemented 781 / archived 148 / proposed 25 / rejected 12；中英双语文件计 1932） |
| **Postmortem** | `docs/postmortem/` | 事故 → 规矩 | 4 篇（ACP 导出丢注入、`!!js` 禁 FS 工具、Web Agent 校验错对象、Landlock 分类错误） |
| **Upgrades** | `upgrades/{plans,manifests,alignment}/` | 上游对齐的计划/决策/证据 | 8 个 release 轮次 |

ADR 有**强制结构**：头三行 `# Agent Note: <title>` + `Status: … — 原因`；正文以 `## Problem` 开头；implemented 必须 `## Decision` → `## Alternatives considered`（**强制**）→ `## Consequences`；禁止事后用 spec-speak 回填（`.agents/notes/README.md:60-121`）。粒度到具体符号与入口路径。另有设计泳道 `.agents/superpowers/{plans,specs}`（4 计划 + 3 设计）。

`upgrades/README.zh.md:17` 有一条很能说明团队性格的规则：

> 描述已发布同步的记录作为该版本的真源；**代码移动时更新事实（路径、名称、版本），不要改写已经作出的决定。**

——事实可以修，决定不能改。这是相当成熟的工程观。

### 5.2 自研 Agent Skill（12 个）

`dsh-pre-push-checks`、`dsh-code-review`、`dsh-doc`、`dsh-doc-standards`、`dsh-doc-site-sync`、`dsh-find-simplifications`、`dsh-merging-stacked-prs`、`dsh-archive-agent-notes`、`dsh-prose-standard`、`dsh-translate-docs`、`dsh-trim-cot-leakage`、`record-browser-gif`

这说明：**AI Agent 是这个仓库的一等开发者**，团队把协作流程本身也工程化了。

### 5.3 门禁链

```
typecheck → build → lint → hygiene → doc-sync
  → verify-cordis-config → verify-plugin-surfaces → verify-package-*
  → test → test:coverage → test:snapshot
```

- CI 覆盖率门禁是 **per-file 100%**（`test:coverage`，不是 `test`）
- 非平凡改动同 PR **必带 ADR**
- 按表面选最小证据，不默认跑全量；CI 拥有全量信号
- `lefthook.yml` 挂载 git hooks

**关于"机制是否真的接线"——这里有一处需要更正的判断**：我此前认为 `upgrades/**` 无门禁消费者，这次核实是**错的**。`verify-upgrade-records` 已登记在 `scripts/run-gates.ts:409`，作为 `doc-lane` 合约门的一部分（与 `verify-package-manifests`/`verify-config-schemas` 同批，属 2026-06 的 lane 化产物），且 `upgrades/README.md` 已被 i18n manifest 覆盖。**upgrades/ 是有消费者的**。此前判断源于按旧扁平 `UPGRADE-*` 前缀搜索，结构迁移后未重搜。

不过仍有一处**真实**的纸面欠账：`test:coverage` 的 per-file 100% 在 `docs/testing.md` 与 `package.json` 都有声明，但 `scripts/` 里**没有**对应强制 per-file 阈值的自研脚本（覆盖率阈值由 vitest config 承载）。考虑到 Phase 1/2 从未真正跑过 coverage（见下），这条门禁的实际约束力存疑。

### 5.4 当前升级轮次（重要现状）

**目标已从 rc.2 重定向到 `dsh-v0.1.6-alpha.2`（`ddefc45f`）**——我此前记忆中的 rc.2 状态已过时。

| 项 | 值 |
|---|---|
| 已登记同步基线 | `dsh-v0.1.5-rc.2` / `fb2c4b9e`（**完成前不得前移**） |
| 本轮唯一目标 | `dsh-v0.1.6-alpha.2` / `ddefc45f` |
| 拟发布版本 | `0.1.6-alpha.2.coharness.1`（本批不改包版本） |
| 已完成 | **0R**（规划重锚）、**1B**（boot/Typert/vendor、dsh-hmr、plugin-manager、`apps/cli` profile-boot）、Phase 1/2（alpha.1 继承） |
| 进行中 | 见 `master` 顶端 3 个提交：`65610434e9`(0R)、`9fd591f128`(1B)、`03668e6d6d`(1B) |
| 待办 | 2B → 3A/3B → 4A/4B → 5 → 6A/6B → 7A-7E → 8 |

#### 主权边界的三个待决问题（已逐项核实）

**（1）两份清单数字不一致，re-baseline 尚未执行**

| 来源 | 分布 |
|---|---|
| `scripts/upstream-sync.json` | 264 包：adapted **230** / owned **29** / replaced 2 / tracked 3；upstreamOnly **32** |
| `UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.1.6-alpha.2.json` | 333 行：adapted **227** / replaced 2 / tracked 3 / upstreamOnly **35** / **`unmanifested` 32** / 无主权字段 34 |

计划正文已写明"`localSovereignty` 为 `unmanifested` 的 32 个上游新包在各自阶段决定携带与否并登记主权，**同步基线前移时写入 `upstream-sync.json`**"。差异约 19 项即由此而来——这不是错误，是**两阶段机制**，但意味着当前 `upstream-sync.json` 还不是 alpha.2 口径。

**（2）34 个无主权标记的其实是 `non-package` 区域，不是核心包**

这 34 行**全部**是 `non-package:*` 前缀：`.agents`、`.github`、`docs`、`apps/cli`、`apps/web`、`apps/desktop*`、`vendor`、`native`、`python`、`scripts`、`website`、`patches`、`snapshots`、`tsconfig.*`、`package.json`、`pnpm-*`、`lefthook.yml`、根 README/AGENTS/THIRD_PARTY_NOTICES。

结论要修正：**没有核心包被漏标**。真正的事实是——`upstream-sync.json` 的 key 只覆盖 `packages/<group>/<pkg>`，所以**上述区域天然不在机器可读的保护范围内**。这是结构性设计而非遗漏，但后果很实在：`apps/`、`vendor/`、`native/`、`python/`、`scripts/` 这些目录在批量同步时**没有主权告警**。而 `native/`（Landlock）与 `python/` 恰恰是我们有本地改动的区域。

**（3）真正需要裁决的：4 个包存在命名冲突**

`unmanifested` 32 项里，有 4 个包**在 `upstream-sync.json` 中标为 `owned`（我们自研），同时在矩阵中标为 `unmanifested`（上游新增）**：

```
packages/boot/hmr            packages/boot/plugin-manager
packages/mcp/mcp-resources   packages/util/lazy-require
```

这说明**上游 alpha.2 也新增了同名包**。"我们的自研包"与"上游同名新包"撞名，必须裁决：是保留我们的实现（登记为 owned/replaced）、还是切换为适配上游版本。这 4 个是 re-baseline 时最需要人工判断的点，比"34 项无标记"更值得盯。

其余 `unmanifested` 是上游新增能力域：`ssh/*`（4 个）、`browser-use/*`、`computer-use/*`、`ptc-runtime/*`、`deliverables/*`（D7 已决定采纳）、`experimental/auto-review`、`document/office-to-pdf`、`skill/skill-office` 等。

**值得注意的过程约束**（UPGRADE-PLAN:alpha.2）：
- Phase 8 验收完成前**不得以 `master` 部署生产**；生产紧急修复从生产提交另开分支
- Phase 1/2 **从未执行 `test:coverage`**，1B/2B 开工前必须先补跑收口 per-file 100%
- "不携带"上游包**不等于"不审查"**——仍须逐行审查增量并把应承接的行为移植到替代面
- 台账：23 项未验证/环境阻塞项，每项绑定承接阶段；**skip 不计通过**

**七条已确认产品策略**（D1-D7）体现了极强的边界意识，例如：
- D1：插件管理**仅管理员**，普通用户的 Full access 或单次审批不授予 profile 管理权；治理与隔离插件不得被此入口关闭
- D2：用户终端按用户/项目**双门授权，默认禁用**；运行实例的系统账号权限 ≠ 登录用户权限
- D4：Session 日志上传**默认关闭**
- D7：采纳 `deliverables/tool-present` 与 `workspace-changes`

---

## 6. 综合判断

### 这个项目做对了什么

1. **定位清醒**：明确承认是衍生项目、明确不承诺与上游逐文件一致、明确保留 `dsh` 词汇是为了可持续对齐。没有"我要做一个更好的 DSH"的幻觉。
2. **把"主权"工程化了**：`upgrades/` + `upstream-sync.json` + `verify-upstream-sovereignty` 这套机制，是国内 fork 型项目里少见的严肃做法——它把"我们改了什么、为什么改、能不能被覆盖"变成了可执行的清单，而不是口口相传。
3. **业务切口选得准**：不做另一个 Agent，做"一群人共用一个 Agent 时的责任归属问题"。Gateway 的 usage_ledger 不存密钥/提示词/回复，这个细节说明设计者真的想过隐私与合规。
4. **治理策略树外化**：`plugins/` 两个插件不进 `packages/`，让"策略"与"运行时"版本解耦。
5. **安全表述诚实**：SAFETY.md 明确说"不要视为完整安全边界""macOS 不提供 mount namespace"，不吹。

### 需要警惕的

1. **控制面完成度不均**：服务端强制层扎实，但 Admin SPA 只有 2 个视图、实例注册表是内存态。管理员的多数能力目前要走 API——这是**产品可用性**的缺口，不是架构缺口。
2. **文档滞后于代码**：README 仍指向 rc.2 记录（实际已到 alpha.2）；CLI 参考 404；Workbench 无文档；用户文档仅 14 篇。对"面向团队"的产品，这是交付风险。
3. **Session 格式历史欠账**：`v0→v1`/`v1→v2` 迁移是 `bump()` 空壳（上游是 443/695 行归一化逻辑），v0 存量日志走的是活路径，会**静默跳过归一化**。这个缺口此前已被审计发现，需确认在 alpha.2 轮次中是否有承接阶段。
4. **4 个包存在主权命名冲突**（见 §5.4-3）：`boot/hmr`、`boot/plugin-manager`、`mcp/mcp-resources`、`util/lazy-require` 同时被标为"我们自研"与"上游新增"，re-baseline 时必须人工裁决。
5. **`apps/`、`vendor/`、`native/`、`python/`、`scripts/` 不在机器可读主权清单内**（见 §5.4-2）——结构性设计，但意味着这些区域批量同步时无告警，而 `native/` 与 `python/` 恰有本地改动。
6. **replaced 面是升级高风险区**：`api/gateway`、`session/session-persistence` 整条替换 + 32 个 `upstreamOnly`，上游一旦改动这些面的事件契约，替代面必须同步跟进——这是本轮 7A/7C 阶段最需要盯的地方。
7. **coverage 门禁约束力存疑**：Phase 1/2 从未执行 `test:coverage`，而 per-file 100% 缺少自研强制脚本承载（见 §5.3）。

**一个正面事实**：2026-09-08 质量审查的高优缺陷已在推进——A2（空问题批次崩溃）与 A3（`cordis_inspect_query` 挂起）由 `b07d7cf79f` 修复并有回归测试；D1（SAFETY 与默认不符）属报告误判、文档自洽；A5（Windows koffi 泄漏）相关 TS 文件在 HEAD 已不存在。**唯一未闭环的是 A1**（Gateway seeded 继承切点），需确认 `session-persistence-gateway/src/index.ts` 的 `listChildContextIds` 是否恢复继承语义。

### 一句话总结

**CoHarness 的本质：用一套严肃的"上游主权管理机制"，在一个开源 Agent 运行时之上，长出一个面向认证团队的责任与控制层。** 运行时是借来的，治理是自己造的——而"能长期既借又造而不分裂"，才是这个项目真正的技术含量所在。

---

## 附：本次通读的证据来源

- 子代理分域报告：架构 / Gateway 控制面 / 用户视角 / 自有资产 / 工程治理（5 路）
- 主代理复核：`scripts/upstream-sync.json`（主权统计，**字段名 `sovereignty`**）、`upgrades/alignment/UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.1.6-alpha.2.json`（333 行逐行统计）、`git log`、`upgrades/plans/UPGRADE-PLAN-dsh-v0.1.6-alpha.2.md`、`.agents/` 结构、`engineering/`、`docs/postmortem/`
- 一手文档：`README.zh.md`、`SAFETY.zh.md`、`upgrades/README.zh.md`
- 复核中被**证伪并已更正**的三处先前认知：① 升级目标不是 rc.2 而是 `dsh-v0.1.6-alpha.2`；② `upgrades/` **有**门禁消费者（`verify-upgrade-records` @ `scripts/run-gates.ts:409`）；③ 主权统计为 230/29/2/3 + 32（非 225/25/4/29）。
- 复核中被**推翻的两处子代理结论**：① 所谓"500+ 个 build 残留"不存在（`git status` 中 packages 改动全是 `.ts/.md/.yaml`，构建产物被 gitignore）；② 所谓"34 个无标记核心包"实为 34 个 `non-package:*` 区域行，核心包**无遗漏**。
