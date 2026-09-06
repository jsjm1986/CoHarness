# CoHarness 对齐 deepseek-harness dsh-v0.1.3-alpha.1：选择性同步审计

- 审查日期：2026-09-06
- CoHarness 基线：`fix/canonical-ci-automation-gates@73e1eb5d0cb7bfbe0dfb54792350fcead07815eb`
- 上游版本：[dsh-v0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)，提交 `d347e703908d0406b7a7ef80e3a0e594d86b2215`
- 上游范围：`dsh-v0.1.2-alpha.5..dsh-v0.1.3-alpha.1`，2,201 个文件，63,846 行新增，30,632 行删除，37 个 first-parent 提交，182 个非 merge 提交。
- 同步方式：语义审计和分阶段适配，不执行跨仓库 merge 或批量 cherry-pick。
- 目标版本：`0.1.3-alpha.1.coharness.1`；Android、vendor、native 保留独立版本线。

## 结论

CoHarness 已经拥有上游 alpha.1 的部分能力：模型发现、任意 MIME 文档上传、断点续传、文件观测、`read_image`、Workspace 根目录处理和 Agent Team 控制工具。此次同步不重复实现这些能力，而是校验差异并补齐缺失的行为。

必须优先处理的是 Session format v2、SessionHandle 和单 Session 写锁。它们会改变 persistence 生命周期和生产数据读取方式，必须在通用上传及其他能力之前落地。本分支已经完成 SessionHandle 的进程内基础接缝、AgentFactory 生命周期接入、projection cache 的格式代次绑定，以及纯函数迁移 catalog；物理代次发布和跨进程锁仍需后续 provider 阶段完成。

## 能力处置

| 上游能力 | CoHarness 当前状态 | 本轮处置 |
| --- | --- | --- |
| SessionHandle、异步 `agentLoop.create()`、Session lock | `AgentFactory.createAgent`/`resume` 已在发布前取得写句柄，并在 Agent teardown 后释放；同步便利入口仍保留 | 采用基础 API；跨进程锁与 provider 原子锁文件另拆阶段 |
| v0/v1 → v2 Session migration | 已有旧事件读取转换；新增纯函数相邻 catalog，物理 provider 尚未接入 v2 generation | 采用 catalog；首次 body read 自动生成 v2、保留旧文件和 inode 仍是后续 provider 阶段 |
| 任意文件上传、进度、取消、续传 | `userdoc` 已支持任意 mediaType、resumable upload、localStorage/IndexedDB resume | 保留现有实现，补齐会话引用、UI 预览和真实组合验收，不引入上游平行 `file-upload` 存储 |
| `read_image` | 已有附件、image modality 和 tool-card | 基线等效，仅核对 extensionless/attachment 路径行为 |
| `FS_NOT_OBSERVED` | 已有 observation policy 和版本保护 | 基线等效，不移植重复实现 |
| HTTP proxy / NO_PROXY | 未发现统一的出站 proxy capability | 新增统一 policy/util，覆盖 Node fetch、SDK 和 child process 能力，保留 telemetry 明确排除项 |
| OpenAI/Anthropic model discovery | 已有 protocol-specific discovery、`models` 对象、Anthropic `/v1/models`、容量字段和 baseURL 归一化 | 基线等效；补 alpha.1 fixtures 和回归，不重写 parser |
| Agent Team `send_message` steer | 已有 send_message 和 continuable subagent | 对照 sender attribution、顺序和 cold resume；只补缺失行为 |
| Workspace/search/Windows root | 已有 Workspace root、Session search 和路径策略 | 逐项补边界测试；不替换 Gateway/UI 入口 |
| macOS x64 runtime wheel | 当前 release 验证没有该 carrier | 作为独立发布构建和 CI 任务适配 |
| 上游历史 Session 性能回退 | 上游 release 明确标记已知回退 | 新增 history-load benchmark；性能未达基线前阻止发布 |

## 实施顺序

1. 记录审计和目标版本，建立本次同步的 manifest。
2. 引入 SessionHandle、异步 agentLoop 创建、单 Session 写锁（本分支已完成进程内基础接入）。
3. 实现 v0/v1 → v2 迁移链、JSONL immutable generation 和 Gateway 逻辑适配（catalog 已完成，provider 接入待继续）。
4. 复用现有 userdoc/attachment，补通用文件上传的会话引用、UI 和 scope 验收。
5. 适配 HTTP proxy、模型 discovery 回归、Agent Team steer、Windows/macOS 和搜索边界修复。
6. 更新版本、文档、release verify、迁移 runbook 和生产 canary 证据。

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
- 通过 typecheck、test、build、hygiene、doc-sync、release verify；assembled Web/Windows/native/real API 证据单独记录，不以本地结果冒充通过。
