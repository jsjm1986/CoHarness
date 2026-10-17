# CoHarness 对齐 deepseek-harness dsh-v0.1.2-alpha.2 / alpha.3：升级核对与适配记录

- 审查日期：2026-09-01
- 我方基线：`master@af328465f4e73d03dc28fd4307a1781764afdd92`
- 上游版本：[`dsh-v0.1.2-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2)（`0a53fb55bea101816fa226bb964ae2bed71c343b`）、[`dsh-v0.1.2-alpha.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3)（`dd6322d604e00eec1ba5e0c8541159906a21094a`）
- 对比统计：alpha.1→alpha.2 为 1609 个文件、28539 行新增、14727 行删除；alpha.2→alpha.3 为 1043 个文件、11337 行新增、11350 行删除。统计使用 `git diff --no-renames --shortstat`，只用于范围确认，不代表应复制全部文件。
- 祖先关系：上游 tag 与 CoHarness `master` 没有共同 Git ancestor；本记录采用提交、文件、接口和行为的语义移植，不执行 merge/cherry-pick。
- 版本策略：CoHarness DSH 发布族使用唯一发行版本 `0.1.2-alpha.3.coharness.1`，代码基线对应上游 `dsh-v0.1.2-alpha.3`；范围是 workspace 根、可发布的 `packages/*/*` 与 `apps/cli`、`apps/web`，以及 `packages/experimental/*` 私有包，发布 tag 为 `dsh-v0.1.2-alpha.3.coharness.1`。`apps/android-shell` 继续使用独立的 `0.1.0`，vendor/native 发布族继续使用各自版本线。该版本表示 CoHarness 的同步代码基线，不代表与上游发行版二进制兼容。

## 1. 结论

两个上游 tag 的 release body 只列产品可见摘要，实际 tag 还包含 Session projection、依赖边界、Remote 错误体系、队列性能、测试门禁和 SQLite 物理后端等提交。核对以 tag 的全部 first-parent/non-merge 提交和源码 diff 为准，再与 CoHarness 的自有 Gateway、ApiProxy、Session persistence、UI façade 和移动端布局逐一映射。

本轮已落地的适配集中在不改变 CoHarness 授权、持久化和模型治理的增量能力：连接恢复提示、Windows loader/文件替换健壮性、Schedule projection 与可选目录、Preset 插件清单分组、长会话导航、代码高亮延迟和增量化、无扩展名图片读取、Tab 命令补全、子代理图片续接、Web Search 端点诊断，以及权限标签本地化。每项均保留在现有包和现有 wire 体系中，并补充行为测试。

上游要求删除的可选 SQLite Session 后端、统一 `RemoteError`/`remote.*` API、focused `ui-chat` 包拆分和依赖 relays 没有直接覆盖，因为它们会改变 CoHarness 的数据格式、认证/ACL、错误代码或业务入口。对应结论是有意不采用或本地等价实现，而不是遗漏。

## 2. 二开保护条件

以下事实在适配中保持不变：

- `gateway/` 的登录 Cookie、CSRF、principal、项目/组织 ACL、Provider 治理、凭据引用和用量记账仍是唯一授权源。
- `packages/host/apiproxy`、`packages/client/connection`、`packages/client/runtime` 的 `history-wire`、projection 水位、项目 participant、文档/附件字段和重连顺序不被上游 Remote API 替换。
- `SESSION_FORMAT_VERSION` 继续为 `0`；`SessionEvent.ignorable` 继续表示未知事件的读取安全标记；Session SQLite 后端和现有迁移/导出业务继续保留。
- `ui-conversation` 继续是 CoHarness 的 UI façade，保留 slots、Conversation Node、移动端 compact 布局、文档中心、工具卡和自有输入机。
- 任何新增模型可见字段都必须来自 Session 事件、持久投影或已授权的 wire frame；浏览器本地状态只用于呈现和乐观回显。

## 3. Release body 逐项处置

### 3.1 alpha.2

| 上游条目 | 处置 | 当前代码证据与判断 |
| --- | --- | --- |
| 连接异常提示、自动重试、立即重连 | 已适配 | `packages/client/connection/src/client/{connection,index}.ts`、`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`、`packages/client/ui-primitives/src/ConnectionIndicator.tsx`；保留本地 `connected/reconnecting` 状态，对 UI 映射为断线/恢复，避免改动现有消费者的状态联合类型。未复制上游依赖浏览器 `online/offline` 事件的暂停器：CoHarness 的 Connection 直接拥有双 logical stream，网络可用性由下一代 transport 结果决定。 |
| 会话头部显示活动 Schedule | 已适配 | 新增 `packages/schedule/schedule/src/projection.ts`、`packages/client/ui-schedule`；默认 Web row 保持禁用，`examples/web-schedule` 显式启用，避免给普通部署增加 Schedule 工具和定时器。 |
| 插件按会话/全局分组、Preset 切换与跨预设搜索 | 已适配 | `packages/preset/agent-presets/src/{composition-inventory,display}.ts`、`packages/host/plugin-inventory`、`packages/client/ui-settings-plugin-inventory`；活跃 mount 读取真实 Fiber，未挂载 preset 只解析文件，无法求值的 `!!js` 保留 `conditional`。 |
| 菜单、滚动、工具文件链接、diff 统计 | 基线等价 | CoHarness alpha.1 已有 stale-while-revalidate 菜单、固定历史窗口、文件链接和折叠 diff totals；本轮没有用上游 focused 包覆盖本地组件。 |
| macOS/Linux 会话加载减少 FS 检查 | 已适配 | `packages/session/session-persistence-jsonl/src/index.ts` 仅在 Windows 对 ENOENT 做父路径 probe；POSIX 继续依靠 ENOTDIR，减少每次探测的 stat。 |
| 长会话和高频实时消息效率 | 已适配/基线等价 | Session projection 的 per-session watermark、raw view identity 去重和现有 `FrameQueue` 已保留；本轮补上 detached append 追赶和稳定 view 测试。 |
| 回答末尾 token 用量/耗时与详情 | 基线等价 | `ui-conversation` 已有 `TurnUsageDisclosure`、`StatsLine`、`sessionStats` 投影和详情面板；不复制上游 `ui-chat` 包的 DOM 结构。 |
| `web_search` 报告实际端点和错误明细 | 已适配 | `packages/web/web-search-deepseek/src/provider.ts` 在网络、HTTP、解析和响应过大错误中携带生效 endpoint 与 Settings→Plugins→Web search 修复指引，取消和凭据错误仍沿用本地分类。 |
| 权限分类本地化 | 已适配 | `packages/client/ui-permission-presets/src/client/{locales,presentation,PermissionRow,index}.tsx` 与 `ui-conversation` PermissionSelect 使用 locale 解析内置 preset；自定义部署名称保留原文，中文 Workspace Write 使用「工作区内修改」。 |
| 首页 logo 动画 | 基线等价 | CoHarness 已有自有 FishLogo/品牌动画；上游展示细节不覆盖业务逻辑，本轮不替换品牌资产。 |
| `@` 菜单下钻面包屑 | 已适配 | `ui-input-trigger` 增加 `drill`/`header`/`InputTriggerCrumb` 契约、Tab 与 chevron 路径、共享高亮和 stale-while-revalidate；`ui-reference` 将目录普通 pick 与显式下钻分开，并保留本地引用/CAS 序列化。 |
| Goal projection 与 turn authority | 已适配 | `dsh-goal` 使用严格 `GoalProjectionState`（含 round/failure）并在注册表存在时走 O(1) 读，未挂载 registry 的 headless 组合保留增量缓存；`agent-loop` 发布 `turnBoundary`，`tool-goal` 按索引扫描事件，避免 suffix 复制。 |
| 工具参数体延迟格式化 | 已适配 | `ui-tool` 的 row model 保留 `bodyRaw`，`formatToolBody` 仅在展开通用行时运行；文件修改类折叠行不再构建完整 pretty JSON 副本。 |
| Inbox 线性化 | 已适配 | Chat 与 Trajectory 使用持久 `PendingState` splice 链和 `currentClaimed` 集合；Chat 不再注册无消费者的 `nextTurnInboxDefinition`，Queue 仍由 Host queue projection 负责。 |
| 包依赖归属与双版本安装 | 已适配 | 新增 `verify-package-dependencies` 检查 production/peer/dev 归属、重复声明和 Host runtime import；新增 npm 双版本布局检查，针对本地大型 peer 图采用静态 peer-range 校验加无 peer 元数据的 npm 物理布局解析。 |
| NPM peer dependency 解析成本 | 适配 | 新增包只按本地 `verify-client-packages`/workspace 规则声明依赖；不批量删除 CoHarness 的 peer，因为其 host/client 双面包和 Gateway 扩展需要显式安装关系。 |
| Node 24.0–24.11.1 启动/HMR | 已适配 | `vendor/loader/src/internal.ts` 按 `getModuleJobForImport`/`getOrCreateModuleJob` 方法识别 v1/v2；`packages/boot/app-boot/tests/loader-shape.compat.spec.ts` 验证当前 resolver 参数顺序。 |
| 设置关闭后焦点返回入口 | 已适配 | `ui-settings-general/SettingsRoot.tsx` 在 portaled panel 提交关闭后恢复 trigger focus，并保留原有 onboarding/inert 行为。 |
| 恢复 `SessionEvent.ignorable` | 基线等价 | `packages/core/session` 已保留 `ignorable?: true`、未知事件拒绝规则和格式版本 `0`；没有引入上游曾回滚的移除。 |
| Remote 网关统一 `RemoteError` | 有意不采用 | CoHarness 的 `TypertGatewayError`、`TypertLookupFailure`、业务 RPC envelope 和 Gateway ACL 已形成独立错误分类；直接改用上游 domain-prefixed `RemoteError` 会破坏客户端错误码、项目授权和管理端诊断。 |

### 3.2 alpha.3

| 上游条目 | 处置 | 当前代码证据与判断 |
| --- | --- | --- |
| 长会话右侧导航预览/跳转全部分页（含未载入） | 已适配 | `ui-conversation/TurnNavigator.tsx` 使用固定 pitch 内部滚动、fade mask、busy marker；`ChatView` 合并 `historyNavigation` index，未载入 marker 经 `loadHistoryUntil` 受现有 persistence/ACL 约束后再定位。 |
| 长会话内存和 syntax highlighting 流畅度 | 已适配 | `ui-primitives/markdown/useViewportHighlighting.ts` 共享 IntersectionObserver；`CodeBlock`/`ReadBlock` 只在可见后高亮，`StreamingHighlightSession.updateFrame()` 以 32 行组增量保留 React 节点；完成 fence 沿用已渲染树。 |
| 权限标签多语言表达 | 已适配 | 内置 read-only/workspace-write/danger-full-access 标签走中英文 locale；自定义 preset 不被误翻译。 |
| 运行中/排队图片回显和可靠投递；持续子代理后续消息支持图片 | 已适配 | `client/runtime` 保留 optimistic image echo，并把 queued 回显固定在 QueueDock；`queue-mirror` 排除图片文本标记，QueueDock 经会话授权缓存加载持久化缩略图；`host/apiproxy` 的 subagent prompt 接收 upload-shaped text/image、先 `admitEncodedImages` 再 `followup`；`core/agent-loop` 记录尚未认领的唤醒并在正常收尾窗口重新拉起 driver；`subagent/continuation.ts` 在 live/cold 两条路径校验子模型 image modality，并在能力查询后再次检查 Activation disposal，避免关闭中的 live child 接收半截图片请求。 |
| `read_image` 读取无扩展名附件路径 | 已适配 | `packages/fs/tool-fs/src/read-image.ts` 对 extensionless bytes 做 PNG/JPEG/GIF/WebP signature sniff，再由 AttachmentStore 完整解码和部署 media policy 校验；扩展名存在时仍检查 declared/actual mismatch。 |
| Tab 补全当前高亮 slash command | 已适配 | `ui-input-trigger` 增加 `tab` arbitration；pending 时消费 Tab，ready 时选择高亮项，无高亮时把按键交还 textarea；Enter 与 Tab 在 stale pending refinement 尚未收敛时都保持菜单打开并消费按键，不会选择旧候选或落入提交。 |
| 后端卡顿不误判断线 | 已适配 | `WebSocketDownlinks` 对 Ping/Pong 采用两个 missed heartbeat 加一轮 `setImmediate` 宽限；Connection 的 stream-open deadline 只解除等待，不因慢 Host 主动 abort。 |
| 窄视口 Schedule catalog 不偏移/越界 | 已适配 | `ui-schedule` 使用 body portal、fixed position、共享 `useAnchoredPosition` clamp 和 portal-aware outside dismissal；普通 Web 默认仍不启用。 |
| 移除可选 SQLite Session persistence | 有意不采用 | CoHarness 的 SQLite Session 数据、schema/迁移/导出和部署业务仍在使用；删除会造成现有二开用户无法继续读写。保留后端不影响 JSONL 路径，也不伪称上游存储兼容。 |

## 4. Release body 之外的范式/基础提交

下表列出实际源码审查使用的代表性提交（不是只按 release body 反推）；同一主题的后续 review/test/merge 提交也纳入上述 diff 统计。

| tag / 提交 | 代码主题 | CoHarness 处置 |
| --- | --- | --- |
| alpha.2 `19b4d7f26c`、`ccfbbb443a`、`18480ff902` | Connection state、恢复控件、WebSocket/逻辑 generation 重连 | 映射到现有 `client/connection` + Settings，不引入上游 Remote transport。 |
| alpha.2 `675efe73f2`、`3e56eaaa0f`、`a12e9de5f7` | Node 24 loader、Windows rename、POSIX JSONL probe | 逐项移植到 vendor/atomic-write/JSONL。 |
| alpha.2 `e5f36cc70f`、`5eb7195f9d`、`8349cc6c73` | Preset composition inventory 与分组展示 | 复用 CoHarness Fiber、slots 和现有 settings UI。 |
| alpha.2 `2a9b940ef5`、`e841fb6049`、`c3b694312f` | Schedule projection、header catalog、状态审查 | 新增 projection 与 opt-in UI，默认组合不启用。 |
| alpha.2 `212df86cf8`、`5ddbc6e71f`、`d25ace0f22` | Projection 迁移、checkpoint、强制 registry | 采用 transition/watermark 语义，保留本地 cache/read ladder。 |
| alpha.2 `804b1ffbfc`、`f9e8fc8f8a`、`674a1e95a3` | Remote failure vocabulary 与 `$host`/gateway 闭包 | 不采用；CoHarness Gateway ACL/RPC 错误分类是本地权威。 |
| alpha.3 `6af1ee49b1`、`b3064cca77`、`218bb7f645` | 全会话 turn rail、load-through 分页与 landing | 以 `historyIndex`/`loadHistoryUntil` 接入单体 `ui-conversation`。 |
| alpha.3 `faa61ada74`、`1dd3e60f50`、`d8e2ac5052` | 视口高亮、增量 stream fence、完成树保留 | 复用本地 Shiki/ReadBlock，并保留 settled tree。 |
| alpha.3 `7c38fd8102`、`ba810b3539`、`21d2d9395d` | 图片 admission、队列回显、关闭轮次唤醒 | 采用 upload-shaped Host admission、queue thumbnail、pending-wake replay 与 continuation disposal cutoff。 |
| alpha.3 `7222e17dc0`、`f3c69c2c3f`、`6f08798981` | 无扩展名 `read_image` 与 dotfile 边界 | 保持 tool-local signature sniff 和 AttachmentStore decode。 |
| alpha.3 `49bf26a794` | stalled Host 的 heartbeat/readiness 宽限 | 采用两次 missed heartbeat + event-loop grace；不让慢 Host 触发主动 abort。 |
| alpha.3 `4553c9d957` | 移除 SQLite Session persistence | 有意不采用，保留现有数据后端。 |

### 4.1 其他提交簇的语义等价与取舍

| 上游提交簇 | 判断 |
| --- | --- |
| Session projection 迁移、`stateVersion`、raw view identity 去重、Schedule projection | CoHarness 已有 projection seam；本轮将 Schedule 接入该 seam，并补上 header/seedLength、detached append 和 per-step raw view gate。上游的 `cachedSnapshot(keys)`/`hydrate()` API 不复制，因为本地 cache 有自己的 identity-bound `SessionProjectionCache` 读梯。 |
| `session-turn-outline`/`loadThrough`/fixed-pitch rail | 以本地 `historyIndex`、`historyNavigation`、`loadHistoryUntil` 和单体 `ui-conversation` 实现同一用户行为，保留 CoHarness history-wire 和窗口锚点。 |
| Shared `dsh-util-values`、`dsh-util-time`、Deque 与 duplicate-install-safe relays | 不直接引入；本地 `dsh-session/json.ts`、`dsh-llm/call-config.ts`、`FrameQueue` 和 scope/service 体系承载等价职责，批量改包会扩大发布闭包。 |
| Remote failure vocabulary、`remote.*` controller 闭包和 focused client package 拆分 | 不采用；会改变 CoHarness Gateway 错误、认证、ACL、wire 和移动端入口。未来若有外部 Remote 消费者，再单独设计双栈。 |
| `read_image` tool-local sniff、prompt admission/image ownership | 采用行为，保留本地 AttachmentStore、文档内容和 Code Mode bridge；图片先持久化再进入 Session/inbox。 |
| CI、snapshot、coverage、Windows ReFS 和 release metadata 提交 | 不把 CI 平台差异伪装成产品同步；已运行本地对应静态/聚焦门禁，Windows/真实 API/浏览器组装证据仍单列。 |

### 4.2 普查结果校正

`agent-team` 的性能影响不能记为零调用：当前 `packages/experimental/agent-team/src/journal.ts` 直接对 Session 事件执行 `foldTeam`，生产路径共有 16 个 `journal.state(root)` 调用点，另有 invariant companion 的独立 fold。该包仍是 experimental，现有 Agent Note 接受 Web `team.get` 的全量 fold；本轮不改变其读取协议，后续若进入正式 profile 再单独迁移 projection。

`llm-retry` 的现状是从未采用上游的 retry projection，当前消费方以 `findLast` 读取事件；这不是本轮引入的回归，且该状态只服务 Host 策略，不进入本轮五项适配。若重试状态要被多个读模型共享，再按 projection seam 评估。

## 5. 已落地文件簇

- 运行时与 vendoring：`vendor/loader/src/internal.ts`、九个 vendor manifest、`packages/util/atomic-write`、`packages/session/session-persistence-jsonl`、`packages/client/connection`。
- 投影与 Schedule：`packages/session/session-projection`、`packages/session/session-projection-cache`、`packages/schedule/schedule`、`packages/client/ui-schedule`、`examples/web-schedule`。
- Preset/插件清单：`packages/preset/agent-presets`、`packages/host/plugin-inventory`、`packages/client/ui-settings-plugin-inventory`、`packages/client/ui-agent-preset` 的共享 display export。
- Web 对话与图片：`packages/core/agent-loop`、`packages/client/ui-conversation`、`packages/client/ui-primitives`、`packages/client/ui-input-trigger`、`packages/client/ui-settings-general`、`packages/client/ui-permission-presets`、`packages/fs/tool-fs`、`packages/subagent/subagent`、`packages/host/apiproxy`。
- 本轮优先适配：`packages/goal/goal`、`packages/goal/tool-goal`、`packages/core/agent`、`packages/client/ui-reference`、`packages/client/ui-tool`、`packages/client/ui-trajectory`、`scripts/verify-package-dependencies.ts`、`scripts/benchmark-npm-resolution.ts`、`scripts/verify-npm-install-layout.ts`。
- 真实浏览器回归：`apps/web/tests/reference-drill.e2e.ts` 与 `apps/web/tests/snapshots/reference-drill/ui.expected.md`。
- 生成物与声明：`tsconfig.base.json`、`tsconfig.client.json`、`packages/client/tsdown.client.ts`、`packages/bundle/web-app/cordis.patch.yml`、`pnpm-lock.yaml`、相关双语 README 和 generated Cordis catalog。

## 6. 验证证据

已执行并通过：

```text
CI=true pnpm install --no-frozen-lockfile
CI=true pnpm exec tsc -b packages/client/ui-primitives/tsconfig.json packages/client/ui-conversation/tsconfig.json packages/client/ui-settings-plugin-inventory/tsconfig.json packages/preset/agent-presets/tsconfig.json packages/schedule/schedule/tsconfig.json packages/host/plugin-inventory/tsconfig.json packages/web/web-search-deepseek/tsconfig.json
CI=true pnpm exec vitest run packages/client/connection packages/fs/tool-fs packages/client/ui-primitives packages/client/ui-conversation packages/client/ui-settings-plugin-inventory packages/client/ui-permission-presets packages/client/ui-settings-general packages/client/ui-agent-preset packages/client/ui-schedule packages/schedule/schedule packages/preset/agent-presets packages/host/plugin-inventory packages/web/web-search-deepseek packages/session/session-projection packages/session/session-projection-cache packages/subagent/subagent packages/host/apiproxy packages/util/atomic-write packages/boot/app-boot/tests/loader-shape.compat.spec.ts packages/client/ui-input-trigger --no-file-parallelism --maxWorkers=1
CI=true pnpm run typecheck
CI=true pnpm run lint
CI=true pnpm run doc-sync
CI=true pnpm run hygiene
CI=true pnpm run check:ci:static
CI=true pnpm run build:lib
CI=true pnpm run build
CI=true pnpm run verify-cordis-config
CI=true pnpm run verify-cordis-api
CI=true pnpm run verify-client-packages
CI=true pnpm run verify-optional-dependency-imports
CI=true pnpm run verify-runtime-closure
CI=true pnpm run verify-client-domain-graph
CI=true pnpm run constraints
CI=true pnpm run release:verify --family dsh
CI=true pnpm --filter @deepseek-ai/dsh-client-ui-schedule bundle
CI=true pnpm --filter @deepseek-ai/dsh-client-ui-settings-plugin-inventory bundle
CI=true pnpm run verify-translation-pairing
git diff --check
```

本轮最后复核：`CI=true pnpm run test` 发现 1 个与本轮适配无关的 hooks-claude-code 工作目录断言偶发失败（975 个文件通过、9 个文件跳过、1 个失败）；单独重跑该文件为 9/9 通过。`pnpm run test:gui` 为 342 个文件、4632 个测试通过（1 个跳过）。新增 `reference-drill.e2e.ts` 的 refresh/replay 均为 2/2 通过，证明真实组装应用中的 `@` 目录 Tab 下钻和面包屑路径可用。

快照门禁随后在默认并发 5 下完整通过：`NODE_DISABLE_COMPILE_CACHE=1 CI=true pnpm exec vitest run --config vitest.snapshot.config.ts` 为 15 个文件、131 个测试通过、2 个跳过。此前一次并发复核出现 headless 启动失败场景超过 30 秒的资源争用超时；该场景串行重跑为 17/17，降低并发后的全套复核也为 15/131 通过。

`DSH_SNAPSHOT=replay pnpm run test:web`（新增专门下钻用例前的 91 文件运行）已完整执行，但当前工作树在本轮前已有的页面快照/fixture 漂移仍使 28 个文件（47 个测试）失败，62 个文件（258 个测试）通过，另有 1 个未处理的历史 wire 错误；失败样例包括默认 locale、工作区新会话按钮、预置会话标签和历史滚动 fixture，并非新增下钻测试。新增用例随后以 replay 2/2 通过。该结果作为发布前基线差异记录，不宣称 assembled Web gate 通过。

本次优先适配随后又执行了以下聚焦校验：

```text
CI=true pnpm run verify-package-dependencies
CI=true pnpm run verify-npm-install-layout
CI=true pnpm exec vitest run scripts/verify-package-dependencies.spec.ts scripts/benchmark-npm-resolution.spec.ts scripts/verify-npm-install-layout.spec.ts scripts/run-gates.spec.ts scripts/check-workspace-constraints.spec.ts --no-file-parallelism --maxWorkers=1
CI=true pnpm exec vitest run packages/goal/goal/tests/goal.spec.ts packages/goal/goal/tests/projection.spec.ts packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts packages/goal/tool-goal/tests/tool-goal.spec.ts --no-file-parallelism --maxWorkers=1
CI=true pnpm exec vitest run packages/client/ui-input-trigger/tests/core-menu.client.spec.ts packages/client/ui-input-trigger/tests/service.client.spec.ts packages/client/ui-input-trigger/tests/menu-view.client.spec.tsx packages/client/ui-reference/tests/browser-plugin.client.spec.ts packages/client/ui-tool/tests/tool-row.client.spec.tsx packages/client/ui-conversation/tests/conversation-node-definitions.client.spec.ts packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts --no-file-parallelism --maxWorkers=1
CI=true pnpm exec vitest run packages/test-support/acp-snapshot/tests/normalize.spec.ts packages/test-support/llm-replay/tests/llm-replay.spec.ts scripts/session-fixture-layout.spec.ts --no-file-parallelism --maxWorkers=1
CI=true pnpm exec vitest run packages/core/agent-loop/tests/config-session-id.spec.ts --no-file-parallelism --maxWorkers=1
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/reference-drill.e2e.ts
pnpm run typecheck
```

上述新增脚本与受影响聚焦套件均通过；最新优先范围聚焦运行是 19 个文件、507 个测试（依赖/门禁 5/73、Goal/authority 4/114、InputTrigger/Reference/Tool/Conversation 7/179、snapshot/replay 支持 3/141），另有 AgentLoop 配置/恢复回归 1 个文件、16 个测试通过；`acp-snapshot/normalize` 变更包含 2 个新的投影测试并已在该支持套件中通过。`verify-npm-install-layout` 实际解析结果为每个发行版本 191 个 DSH 包、510 条内部 production/optional 边，另先检查 1,244 条源码 peer 边、再以 2,488 条合成 peer 边的静态同版本检查覆盖 npm peer solver 被本地大型循环图放大的部分。

受影响套件共通过 226 个测试文件、3775 个测试；其中 agent-loop 的 18 个文件、338 个测试、continuation 的 110 个测试和 InputTrigger 的 54 个测试均通过。此前一次全量 `CI=true pnpm run test` 通过 973 个文件、15933 个测试，跳过 9 个文件、114 个测试；最后复核为 975 个文件通过、9 个文件跳过和 1 个与本轮无关的 hooks-claude-code 工作目录断言失败，单独重跑该文件 9/9 通过。`CI=true pnpm run test:coverage` 的测试本身通过 973/982 个文件、15933/16047 个测试，但全仓逐文件 100% 覆盖门禁仍返回 1；失败清单包含既有未覆盖的 attachment、LLM、SDK、userdoc/UI 等文件，也包含部分本轮扩展文件，需在独立 coverage-partition 工作中处理，未以覆盖率结果冒充通过。完整 `typecheck`、`lint`、`doc-sync`、`hygiene` 和 `build:lib` 已在 macOS 源码/产物平面通过；浏览器 assembled snapshot、Windows native、真实 API e2e 和生产 canary 仍属于发布前外部验证，不在本地结果中冒充通过。

版本同步后的 `CI=true pnpm run release:verify --family dsh` 解析出 248 个发布成员并确认统一版本 `0.1.2-alpha.3.coharness.1`；`CI=true pnpm run release:pack --family dsh` 生成 248 个 tarball，逐个读取包内 manifest 后版本集合只有 `0.1.2-alpha.3.coharness.1`。使用 DSH、9 个 vendor 包和 Landlock entry 的隔离安装在 `npm_config_ignore_scripts=true` 下成功，并由纯 Node `dsh --version` 报告该版本；Python 发布转换器将该仓库版本映射为公开的 PEP 440 版本 `0.1.2a3.post1`，Python 版本套件 13 个测试和 SDK wheel 构建均通过。macOS 正常生命周期脚本路径因 `koffi` 缺少预构建文件且主机没有 CMake，仍属于平台未验证项。一次并行全量测试中的 HMR 时序失败在单独的 `packages/boot/app-boot/tests/user-patches.spec.ts` 重跑中以 16/16 通过复核，未改动该测试或运行时逻辑。

## 7. 回滚与后续边界

所有适配保持可通过配置关闭的新增 UI（Schedule catalog）和可回退的旧 API；没有在线迁移 Session 数据，也没有删除 SQLite、ApiProxy 或 Gateway 错误分类。若任一浏览器/Windows/真实 API 验证失败，回滚新增 bundle row 或对应 commit 即可，既有 Session 文件和二开业务不需要转换。

后续若要继续追上游，先重跑两个 tag 的 `git diff --no-renames` 与提交清单，再检查本记录的“有意不采用”项是否仍成立；不得把上游下一个 tag 的删除/重命名自动套进 CoHarness。
