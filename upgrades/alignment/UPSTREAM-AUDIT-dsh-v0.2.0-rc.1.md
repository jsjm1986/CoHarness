# CoHarness → dsh-v0.2.0-rc.1 上游审计

## 范围来源与核对方法

本轮目标 `dsh-v0.2.0-rc.1`（`4878cdabd87d4041bdaff61d04c966883b9fd07a`），自上一轮已验收基线 `dsh-v0.1.6-alpha.2`（`ddefc45fbc7f8e46dd73185e68295696d1297887`）起累计 **1,885 个提交（其中 1,252 个非合并，清单登记口径）、7,008 个变更路径（rename 检测口径；矩阵按 `--no-renames` 原始口径登记 7,106 条，重命名拆为删+增两侧）、+472,608/-154,465 行**。中间 tag `dsh-v0.1.7-alpha.1`、`dsh-v0.1.7-alpha.2`、`dsh-v0.1.7-rc.1`、`dsh-v0.1.7-rc.2` 均为 rc.1 的线性祖先，直接以 rc.1 为唯一比较目标。

核对方式：包级三向清点（上游 316 / 本地 304 / 共享 270）+ 全部 `fix(` commit 逐条判定（577/577，分包侧 123 条见 [HOST-FIX-AUDIT](UPSTREAM-FIX-AUDIT-HOST-dsh-v0.2.0-rc.1.md)、客户端侧 454 条见 [CLIENT-FIX-AUDIT](UPSTREAM-FIX-AUDIT-CLIENT-dsh-v0.2.0-rc.1.md)）+ 多轮交叉验证（完整性审计、排除面反向依赖审计各一轮，外包审计产出曾出现编造并已剔除、以手工复核结果为准）。feat 类 commit 的逐条落账仍在进行，特征级结论以矩阵行 `pending-cumulative-source-review` 为准。

## 架构级分叉（不允许文件级归并）

1. **settings 存储模型**：上游 rc.1 把 settings 重写为 cordis profile patch 的 schema 投影并删除 `settings-file`；我方保留 settings.yaml + `projectWrite`/`projectWritePaths` + revision fencing 治理模型，`settings/settings-file` 降为 `owned`。上游的投影/脱敏/冲突处理按行为选择性吸收，绝不替换持久化地基。
2. **preset 平面**：上游把 `preset/agent-presets` 删除并拆为 `preset/agent-preset` + `preset/agent-preset-registry`（mount 424→272 行精简）；我方同路径扩展到 482 行且多出 Remote 契约/authoring/inventory 面。已批准迁移到上游双包结构，在 P5 独立相位把 remote/authoring/inventory 层重挂到新注册表上；迁移完成前 `preset/agent-presets` 记 `owned`。
3. **session-format 同名碰撞**：上游 rc.1 新增 `packages/session/session-format-v3-to-v4`（streaming tool-role + attachment/link 迁移，V4），与我方同名 owned 包（流式块折叠，链已至 v6）语义完全不同。门禁新增 `upstreamShadowed` 字段表达「同键不同义」；上游 V4 事件内容（`developer/message`、`forked`、`plugin:<name>` source kind、attachment-link）作为 v6→v7 新边逐事件并入，已提交代次不可变。

## 编译/组合面硬约束

- vendored cordis 缺 `Volatile`/`VolatileSnapshot`（上游经 cosmokit 导出）——采纳 `.volatile()` 语义的上游源码之前必须完成 vendor 三向合并，否则编译期阻塞。
- `configForms` 服务（`client/ui-settings` 提供）被上游 17 个 client 包硬注入；已决定不引入该服务，吸收的包逐包改写注入到我方 settings 管线。
- `api/session-controller` 的 client 类型面（`ClientSessions`/`Session`）被上游全部 ui-* 使用；已决定不携带该包，吸收的包逐包改写注入到 `client/runtime`。
- `api/remotes` 在 rc.1 client index 硬导入约 20 个面——先重写我方 remote index，再做各包归并。
- `client/store` 不携带：我方 `client/runtime` 已有 `createSnapshotStore`/`defineStore`/`shallowEqual` 等价导出，吸收包的 import 逐包重映射到 `client/runtime`，不引入垫片包。
- bundle 里 rc.1 的 `settings` 行是同 row id 不同服务身份（profile-patch 投影），保留我方 `dsh-settings-file` 行；账号/遥测行在移植时剪除。
- `experimental/agent-team-web-profile` 上游已删（并入 `agent-team-profile`）——P8 跟随删除。
- `skill/tool-workspace-dependencies` 与 owned `boot/workspace-dependencies` 工具名撞车，暂缓携带。
- spill-policy `maxInlineBytes`→`maxInlineTokens` 语义从字节变 token：同 PR 改全部 yml/快照并按模型上下文重新推导数值，旧键必须响亮失败。
- LLM：`llm-deepseek` 拆为纯库 + `llm-deepseek-api-key`；不携带 `llm-deepseek-account`。持久化配置里的 `protocol: chat-completions` 键随拆分迁移或响亮拒绝。

## 已锁定的业主决定（2026-09-29）

| # | 决定 |
| --- | --- |
| 1 | `api/session-controller` client 类型面：逐包改写注入到 `client/runtime`，不携带上游包、不加适配层 |
| 2 | `configForms`：逐包改写注入到我方 settings 管线，不引入适配服务 |
| 3 | jobs 采纳上游环形输出重写（JobChunk/lossy/spillPath/owner:SessionId/JobView），远程面并入 `host/apiproxy`，不携带独立 `api/job-controller` |
| 4 | `apps/cli` 与 `apps/web` 同级全量 commit 意图审计 |
| 5 | tool-bash 空 justification 保持我方更严的拒绝（显式分叉） |
| 6 | tool-jobs `maxConsecutiveWakes` 上界调为 10（不无界） |
| 7 | developer-tools 保持门控默认关（上游 93caf245 的默认开启不采纳） |
| 8 | xlsx 预览引入 fortune-sheet 渲染器并吸收上游修复；office-to-pdf 仍服务其余 Office 文档 |

## 排除面（upstreamOnly，46 包）

账号链 ×6（account-controller、deepseek-account×2、llm-deepseek-account、ui-settings-account、product-analytics）、遥测 ×2（product-telemetry-otel、telemetry/otel——保留自包含 session-telemetry-otel）、语音/STT 链 ×5、快捷键 ×2、schedule-bundle、config-editor、controller 面（job/session/settings/workspace/workspace-files，行为移植到 apiproxy/runtime）、ui-chat/ui-session/ui-approval/ui-plugin-manager/ui-sidebar-files/ui-sidebar-documentpreview/file-upload/resources/store（行为移植到等价物）、上游 session-format-v3-to-v4（遮蔽）、inspector/webworker 两件、5 个 ui-settings-* 分区（内容落进我方 settings 面）、llm-deepseek-api-key/preset 双包/code-language/workspace-path/remote-mock（标「待 P1/P5 携带」，携带时移入 packages）。排除不代表不审查：`fix(desktop)` 类 commit 的 packages/ 夹带修复已抽查（directory-picker drive-probe 已确认一例），全部排除行在矩阵里仍有 commitScope 覆盖。

## 证据限制

- fix commit 判定基于「标题 + 触碰路径 + 本地等价面核对」，未逐条 `git show` 全文；标记 `port` 的行在应用前仍需 diff 级复核。
- 客户端 TOP-10 与分包 TOP-10 的共同根因（网关就绪门/流驻留、blank writer 复用、spill 杀宿主、pi-ai O(n²) 补丁缺失）已各自定位到本地文件行号，可直接实施。
- 未验证台账与先前一致：真实浏览器双用户、生产部署、PostgreSQL、Linux/Windows 平台项在各相位完成后登记到矩阵 `reviewState`，本审计不声明任何项已验收。
