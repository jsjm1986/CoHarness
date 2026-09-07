# CoHarness 对齐 deepseek-harness dsh-v0.1.3-alpha.1：选择性同步审计

- 审查日期：2026-09-07
- CoHarness 基线：`master@aefc098da89f3bd90b836b2ee9ade1a2e5f44097`；审计分支：`codex/upstream-alignment-audit`
- 上游版本：[dsh-v0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)，提交 `d347e703908d0406b7a7ef80e3a0e594d86b2215`
- 上游范围：`dsh-v0.1.2-alpha.5..dsh-v0.1.3-alpha.1`，2,201 个文件，63,846 行新增，30,632 行删除，37 个 first-parent 提交，182 个非 merge 提交。
- 同步方式：先建立共享核心的行为/API/协议矩阵，再按 seam 分阶段适配；不执行跨仓库 merge 或批量 cherry-pick。
- 目标版本：`0.1.3-alpha.1.coharness.1`；Android、vendor、native 保留独立版本线。

## 结论

CoHarness 已经拥有上游 alpha.1 的部分能力：模型发现、任意 MIME 文档上传、断点续传、文件观测、`read_image`、Workspace 根目录处理和 Agent Team 控制工具。此次复核把共享核心的行为/API/协议作为对齐标准，把 Gateway、协作、文档、Android 和部署能力作为受保护的 CoHarness 产权。

必须优先核验的是 Session format v2、SessionHandle 和单 Session 写锁。它们会改变 persistence 生命周期和生产数据读取方式，必须在通用上传及其他能力之前闭环。本分支已包含 provider generation 迁移、JSONL 跨进程锁和 AgentLoop 生命周期修复；本轮完成本机能力层、文档和构建门禁核验，跨进程、跨平台、真实 API 与生产 canary 仍需在相应环境执行。

## 当前复核结果

- 本地与上游没有共同 Git 祖先；直接树比较为本地 9,191 个文件、上游 9,080 个文件、9,562 个变更路径。数字只用于定位范围，不作为行为等价证明。
- 本地代码已将 `SESSION_FORMAT_VERSION` 提升为 `2`，并加入 JSONL/SQLite/Gateway 的迁移接缝；旧版 README、根规则、持久化目录和生成器中的 v0 叙述已修正，应用输出快照已刷新到 v2。
- AgentLoop resume 之前在读取后才取得写所有权，且 teardown 先从 registry 脱离再关闭 handle；这会在 resume/reload 并发下产生所有权竞态。本分支已调整为先取得写 handle，并在 registry detach 前完成 handle close。
- SQLite 资源边界测试自身含有内联 SQL；本分支已将语句移入固定测试资源，保持资源边界检查有效。
- continuable subagent 在 provider/persistence await 期间缺少父 Activation 暂存持有；本分支已补齐建立、冷恢复和投递期间的 parent hold，并在失败时回收。
- seeded child 的 inherited event count 已从 SessionPreparation 传入 persistence handle；继续性继承、冷恢复和工具控制回归均通过。
- preset 重组现在发出带作用域的 `agent-preset/recomposed` 事件，模型可见的 Agent 级 subagent 注册会随旧 composition 一起回收；Web preset、ACP demo 和 built CLI e2e 已覆盖该路径。
- 当前定向测试通过：Session、format、JSONL、SQLite、AgentLoop 共 50 个文件、1,302 个测试；Subagent 28 个文件、657 个测试；LLM 52 个文件、1,176 个测试；Web 11 个文件、287 个测试；Attachment/API 27 个文件、335 个测试；选定客户端 72 个文件、915 个测试。
- 无代理变量时的 keyless snapshot 输出已刷新到 Session format v2；完整快照的 headless 终端失败场景在并行负载下偶发超过 30 秒，单独运行通过。

## 能力处置

| 上游能力 | CoHarness 当前状态 | 本轮处置 |
| --- | --- | --- |
| SessionHandle、异步 `agentLoop.create()`、Session lock | `AgentFactory.createAgent`/`resume` 已在发布前取得写句柄，并在 Agent teardown 后释放；同步便利入口仍保留 | 采用基础 API；跨进程锁与 provider 原子锁文件另拆阶段 |
| v0/v1 → v2 Session migration | 已有纯函数相邻 catalog，JSONL、SQLite、Gateway provider 已接入 generation 迁移；旧 generation 保留 | 采用 catalog 和 immutable successor；生产复制 dry-run、回滚和 canary 仍需外部环境证据 |
| 任意文件上传、进度、取消、续传 | `userdoc` 已支持任意 mediaType、resumable upload、localStorage/IndexedDB resume | 保留现有实现，补齐会话引用、UI 预览和真实组合验收，不引入上游平行 `file-upload` 存储 |
| `read_image` | 已有附件、image modality 和 tool-card | 基线等效，仅核对 extensionless/attachment 路径行为 |
| `FS_NOT_OBSERVED` | 已有 observation policy 和版本保护 | 基线等效，不移植重复实现 |
| HTTP proxy / NO_PROXY | 已有统一 policy/util，并由 Web/LLM 相关 provider 使用 | 保留 CoHarness 出站策略；继续补齐生产路由清单和 NO_PROXY 语料 |
| OpenAI/Anthropic model discovery | 已有 protocol-specific discovery、`models` 对象、Anthropic `/v1/models`、容量字段和 baseURL 归一化 | 基线等效；补 alpha.1 fixtures 和回归，不重写 parser |
| Agent Team `send_message` steer | 已有 send_message 和 continuable subagent；父 Activation hold、sender attribution、顺序和 cold resume 已验证 | 保留现有 Agent Team 产权；外部 provider 和进程重启证据后置 |
| Workspace/search/Windows root | 已有 Workspace root、Session search 和路径策略 | 逐项补边界测试；不替换 Gateway/UI 入口 |
| macOS x64 runtime wheel | 当前 release 验证没有该 carrier | 作为独立发布构建和 CI 任务适配 |
| 上游历史 Session 性能回退 | 上游 release 明确标记已知回退；本轮未运行长历史 benchmark | 新增 history-load benchmark；性能未达基线前阻止发布 |

逐项状态和命令证据记录在 [`UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.1.3-alpha.1.json`](UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.1.3-alpha.1.json)。

## 实施顺序

1. 记录审计和目标版本，建立本次同步的 manifest。
2. 核验 SessionHandle、异步 agentLoop 创建、单 Session 写锁在 JSONL、SQLite、Gateway provider 上的生命周期和并发语义。
3. 核验 v0/v1 → v2 迁移链、immutable generation、torn-tail、未知事件和 rollback；失败路径必须保留旧 generation 且不产生隐式降级。
4. 复用现有 userdoc/attachment，补通用文件上传的会话引用、UI 和 scope 验收。
5. 适配 HTTP proxy、模型 discovery 回归、Agent Team steer、Windows/macOS 和搜索边界修复。
6. 更新版本、文档、生成器、release verify 和迁移 runbook；生产 canary 与跨平台证据保留为发布前工作。

## 全量对齐审计顺序

1. 建立提交、包、导出 API、事件、配置、Cordis patch、SDK/ACP wire 和生成物的逐项矩阵；每项必须标注 `adopt`、`adapt`、`equivalent`、`retain`、`defer`、`remove` 或 `missing`，并绑定生产调用方与测试证据。
2. 先审计 Session、persistence、AgentLoop、LLM stream 和 Subagent steer，再审计工具、附件、API/SDK、UI 和 CoHarness 业务层；任何 P0/P1 缺口先阻断后续清理。
3. 对本地独有的 Gateway、ACL、项目协作、userdoc、Android、native 和 vendor 建立保护矩阵，验证上游适配不会绕过授权、可见性、用量或存储责任。
4. 对 deprecated getter、旧格式读取器、双 persistence backend、重复 transport/UI、同步便利 API 和废弃工具执行生产调用点分类；只有无生产消费者且没有格式/协议责任的表面才可删除。
5. 将矩阵、缺口、冗余和外部环境结果写入 manifest；实现阶段按 Session、Agent/LLM、API/UI、业务层和清理收尾拆分提交。

## Session 迁移规则

- `open` 读取旧 body 时自动生成最高 canonical v2 generation。
- `stat/list` 只识别旧 header，不提前写入 successor。
- 旧 generation 的文件、bytes、inode 保留；运行时不自动降级或删除。
- 迁移通过同目录临时文件、源 fingerprint 重检和 no-overwrite publication 完成。
- 迁移失败保持旧 Session 可读，清理临时文件并返回结构化错误。
- 生产发布前必须完成备份、复制数据 dry-run、迁移统计和 canary 验证。

## 明确不采用

- 不替换 CoHarness Gateway、ACL、session persistence 或 document storage。
- 不引入上游 `ui-chat` DOM 结构覆盖现有 `ui-conversation`。
- 不删除 SQLite、Gateway persistence、userdoc 或 attachment 能力。
- 不直接复制上游 release 的测试、CI、generated catalogs 或 vendor 文件；只取与 CoHarness 行为匹配的证据和修复。

## 验收

- Session migration 覆盖 JSONL、compressed JSONL、Gateway、torn tail、cancel、collision、concurrent writer 和 rollback。
- Session lock 覆盖 second writer refusal、close/reopen 和 process restart。
- 文档上传覆盖任意 MIME、progress、cancel、resume、scope ACL、引用、预览和 Agent file read。
- Proxy、model discovery、Agent Team、Windows/macOS 各有 unit 或真实 Loader 组合测试。
- 每个共享核心变化都必须有 source-plane 测试、built/artifact smoke 或 keyless snapshot；每项保留的 CoHarness 行为都必须有 ACL/作用域/生命周期证据。
- 本轮已通过 `typecheck`、`lint`、`build`、`hygiene`、`doc-sync`、dsh/vendor `release verify`、共享核心定向测试、能力层定向测试、无代理变量的 keyless snapshots 以及 keyless e2e；Gateway snapshot 在重编译 `better-sqlite3` 当前 Node ABI 后通过。
- 使用 CPython 3.12.13 入口完成全量单测：994 个文件、16,507 个测试通过，9 个文件、116 个测试按既有条件跳过；系统默认 `/usr/bin/python3` 为 3.9.6，只能作为环境说明。
- Windows/native、macOS x64 runtime、真实 API、生产 canary 和长历史性能仍未在本机执行，必须单独记录，不能用本地结果代替。
