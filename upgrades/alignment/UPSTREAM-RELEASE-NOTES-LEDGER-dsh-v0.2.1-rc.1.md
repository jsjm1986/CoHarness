# 上游发布说明逐条对账 — dsh-v0.2.1-rc.1

## 范围与方法

- 输入：`dsh-v0.2.1-rc.1`(`1600d8a`,与 rc.1 时点的 upstream/master 同头）发布说明全部条目。rc.1 说明为 alpha.2→rc.1 周期累计汇总，与 alpha.4 台账重叠的条目沿用 [alpha.4 台账](UPSTREAM-RELEASE-NOTES-LEDGER-dsh-v0.2.1-alpha.4.md)判定。
- 证据:fork 与上游无 merge-base,按包级树对比 + 功能符号探测;四个并行审查覆盖 release/API/UI/包级缺口;每项判定经人工复核源码存在性。
- 本地基线:`feat/upstream-sync-batch2` 分支,含本周期落地提交 `d2b36fc`、`9e80447`、`94c1ed2`。

## 判定口径

| 代码 | 含义 |
|---|---|
| Y | 已有/本周期落地(注明提交) |
| N | 缺失(注明阻塞) |
| L | 有意分歧/待统一决策 |

## 本周期新落地(原 N → Y)

| 条目 | 落地提交 | 说明 |
|---|---|---|
| 参数生成序指引(bash/pwsh/fs schema + justification 语言条款) | `d2b36fc` | 上游 `4166dbd`;run_code 保留本地刻意的 code-first 参数序 |
| file-reference @ 富文本 prompt | `d2b36fc` | 上游终态 "Tokens prefixed with @…" 全文;57 场景快照刷新 |
| pi-ai 0.87.1 → 1.1.0 + Azure provider 更名 `azure` | `9e80447` | 上游 `d79f13a4d46`;tool 新增改内联 `tool_definition`;升级指南三件套已建 |
| 进程相关 prompt 值(checkout 路径/Web URL)迁运行时上下文 | `94c1ed2` | 上游 `36779dcf099`+`adfa92bca189`+`2b229d4c0e5`;新增 `context/harness-dev-context`、`webApp.getAdvertisedUrl()`、`WebServer.bindUrlHost()/getOrigin()`;HMR 文案保留本地 `DSH_CLIENT_HMR=1` 语义 |
| 嵌套 presentationMeta + `tool/ptc-dispatch` 事件 meta 持久化 | `b17eb0f` | 上游 `c7e62c1`/`839bd51`/`d6adc5d` 语义增量 |
| cordis-plugin-development skill 全量同步 | `104e525` | practices.md/user-actions.md 等 8 个文档提交终态 |
| package-meta icon/SVG 门禁 + 嵌套包资源检查 | `9156742` | display-resources 测试合并 |

## 确认已落地(Y)

Session plugin 记录(#5677)、持久 PTC(#5035)、subagent Agent Presets(#4643)、pi-ai 会话内 system prompt/动态工具(#4934)、共享 agents 目录 + `DSH_AGENTS_HOME`(#5693)、麦克风选择(#5729)、SDK resume(#5988)、字体设置(#5328)、both 模式移除(#5800)、subagent 图片粘贴恢复(#5866)、Office 渐进指引、`working_directory` 工具、`--public-url`、`--tls-cert/--tls-key`、`engines.dsh`、subagent 立即返回 child ID + `session/wait`、Markdown frontmatter 字段列表(`ui-workbench/frontmatter-fields`)、插件自定义索引源(`plugin-market`)。

## 缺失(N)

| 条目 | 缺失面 | 阻塞/备注 |
|---|---|---|
| SSH 独立 helper 运行时 | `ssh/ssh-helper-runtime` + `build-exe-for-ssh-helper.yml`/`publish-ssh-helper.yml` | 需将 `LaunchConfig` 改回上游 `kind:'node-script'|'embedded'` 判别联合(反转 #5035 本地扁平化);发布工作流是否纳入 fork 管线属决策项 |
| API 按调用方授权/连接管理 | `api/*-controller`(7)、`api/remote-access`、`api/workspace-files` | 与本地 `host/apiproxy`+`gateway-*` 架构相交,依赖决策项 3 |
| Claude Code Mods 兼容层 | `experimental/claude-code-mods`、`client-ui-claude-code-mods` | 实验包,待取舍 |
| 思考翻译插件 | `experimental/translator`、`cot-translation-bundle`、`client-ui-cot-translation` | 实验包,待取舍 |
| Git Worktrees 插件 | `experimental/tool-worktree`、`worktree` | 实验包,待取舍 |
| DevTools 组合包 | `experimental/{inspector,inspector-profile,session-inspector,session-search,session-titles-bundle,terminal-bundle,ralph-bundle}` | 上游内部实验基建 |
| DeepSeek 账号登录 | `credentials/deepseek-account`、`deepseek-account-platform`、`llm/llm-deepseek-account` | 产品策略相关 |
| Automation 内建 Web + 模式限定提醒 | `schedule/tool-schedule` | 本地 `schedule/schedule` 直挂 reminder,无模式限定 |
| 发送消息密钥脱敏 | `client/ui-secret-mask` | UI 重组后需按功能核接入点 |
| 其余 | `boot/config-editor`、`telemetry/otel`、`host/product-telemetry-otel`、`experimental/{cua,cua-macos,badge-skill-bundle,webworker-packer,webworker-runtime}`、一批 `client/ui-*` 拆分包 | 多为上游内部实验基建 |

## 结构性分歧(待统一决策→已裁决)

1. `runtime-diagnostics/invariants`:**已裁决=跟随上游移除**(上游 `f028f25667d` 1355 文件删全部 `./invariant` 伴生+门禁;本地 44 个 src/invariant.ts + verify 门禁一并拆除,invariant 覆盖路径按上游 `96371534` 范式补成普通测试)。
2. `agent-instructions` 的 `dshHome`:**误判,已对齐**——本地 config.ts 与 upstream master 逐字节一致(行级覆盖早已删,`resolveDiscoveryConfig` 保留 owner 注入参数;README 写明"遗留行键被忽略")。
3. API 层:**已裁决=维持本地 `apiproxy`/`gateway-*` 主权**(upstream-sync.json 已锁 controller 全 replacedBy);`api/remote-access` 按**概念移植**处理——在 `typert-gateway/authorize` 接缝内引入 role/binding/policy 注册表 + per-principal 快照,`collaboration.authorize()` 作权威后端(~10-20 文件),不做 controller 拆分。
4. preset 模型:**已裁决=执行完整 P5 迁移**(agent-preset + agent-preset-registry 双包,~200 文件;保留 realm split、`trust`/`authorable`/`projectWrite`/`modeSelectionEnabled` 治理字段、`agent-preset/recomposed` 事件;既有批准记录在 upstream-sync.json:1298 与 UPSTREAM-AUDIT-dsh-v0.2.0-rc.1)。
5. #4394 subagent:**已裁决=补残余语义不迁统一激活**——catalog 加 `mode:'external'` 叶 + `delivery:'caller'` 等价物(~10-20 文件),保留外部可续接 Team 成员(fork 独有能力);subagent 包族 `upstream-sync.json` 记 verified-divergent。
6. UI 面条目:五名项核算为 在场(Creator 入口、插件生命周期 dep-sync)/分叉(会话ID 条-展开在场复制缺、窄窗-任务在场插件页缺)/缺失(收起时机);全部 UI 缺口裁决为**补齐**(7 项:~2M+4S)。
7. `ssh-helper-runtime`:**已裁决=全量移植**——`LaunchConfig` 改回上游 `kind:'node-script'|'embedded'` 判别联合 + pkg SEA 打包 + 两工作流适配 fork 管线(远端免 Node 为实质部署收窄)。
8. rc.1 实验包:**已裁决=全部可移植项引入**(worktree、ui-secret-mask、cot-translation、claude-code-mods、DevTools inspector 组、webworker 对,分批落地);锁定产品包(deepseek-account 账号链、product-telemetry、config-editor)**维持排除**。
9. rc.2(`dsh-v0.2.1-rc.2`,`687f282`,rc.1+9 提交)增量:web-deepseek-api 新包 + `web` seam search/fetchProvider Volatile 化 + ui-settings-web-search 卡 + `web-search-deepseek` locale + `web/deepseek-search-llm-request` 加 `thinking` + deepseek-fetch 快照场景——**全部直补**;`ui-deepseek-model-label-1017` 临时徽标**裁决=不引入,fork 用自有品牌**。

## rc.2 升级指南回填裁决(E11)

`docs/upgrade-guide/v0.2.0-rc.2/` 上游 6 篇:

| 指南 | 裁决 | 依据 |
|---|---|---|
| `remove-runtime-invariants` | **已落地**(E9) | 三件套与上游逐字节一致 |
| `account-sign-in-errors` | **不引入** | `deepseek-account*` 账号链维持排除(决策项 8 产品锁定);fork 无 `SignInErrorCode` 面 |
| `schedule-bundle-retired` | **不适用+缺口已补** | fork 从未发布 `experimental-schedule-bundle`,套餐移除无对应面;preset 声明 `tool-schedule` 缺口已在 `3bd8b04bf09` 补齐 |
| `subpath-plugin-display-manifest` | **已承载** | `app-boot/package-meta.ts` 与上游一致:仅 package-root 读 package.json,subpath 只靠 `<specifier>/icon` 导出;`package-meta.spec.ts` 100 测覆盖;指南三件套已回填 |
| `primary-runtime-python-aliases` | **已落地** | sibling-link 校验已移植 `primaryRuntimePythonAliases`/`copyPrimaryRuntime` + smoke 校验;指南三件套与上游逐字节一致 |
| `bundled-python-tests` | **已落地** | `prunePrimaryRuntimePythonTests` 已移植并在 wheel 解包后调用,同步裁剪 RECORD;指南三件套与上游逐字节一致 |

未写指南记录无对应行为的分歧,避免文档声称未承载的迁移。
